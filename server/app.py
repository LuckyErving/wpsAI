import os
import json
import threading
import time

from flask import Flask, request, jsonify
from flask_sock import Sock
from flask_cors import CORS
import jwt
import bcrypt
import pymysql
from dbutils.pooled_db import PooledDB

# ── 配置 ─────────────────────────────────────────────────────
SECRET_KEY = os.environ.get('SECRET_KEY', 'wps-collab-secret-please-change-in-production')

DB_CONFIG = {
    'host':     os.environ.get('DB_HOST',     'localhost'),
    'port':     int(os.environ.get('DB_PORT', 3306)),
    'user':     os.environ.get('DB_USER',     'yyw'),
    'password': os.environ.get('DB_PASSWORD', 'yyw110'),
    'database': os.environ.get('DB_NAME',     'wps_collab'),
    'charset':  'utf8mb4',
}

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})
sock = Sock(app)

_pool = None   # 连接池，延迟到 init_db 后创建


# ── 数据库 ────────────────────────────────────────────────────
def get_db():
    """从连接池取连接，用完后调用 conn.close() 归还到池"""
    return _pool.connection()


def init_db():
    global _pool
    # 先不指定 database，确保库存在
    root_cfg = {k: v for k, v in DB_CONFIG.items() if k != 'database'}
    conn = pymysql.connect(**root_cfg)
    with conn.cursor() as cur:
        cur.execute(
            'CREATE DATABASE IF NOT EXISTS `{}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
            .format(DB_CONFIG['database'])
        )
    conn.commit()
    conn.close()

    # 创建连接池
    _pool = PooledDB(
        creator=pymysql,
        maxconnections=20,
        mincached=2,
        maxcached=10,
        blocking=True,
        **DB_CONFIG,
    )

    # 建表
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id       INT          AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50)  UNIQUE NOT NULL,
                password VARCHAR(128) NOT NULL,
                realname VARCHAR(50)  DEFAULT '',
                created  DATETIME     DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')
    conn.commit()
    conn.close()


# ── JWT ──────────────────────────────────────────────────────
def create_token(user_id, username):
    payload = {
        'user_id': user_id,
        'username': username,
        'exp': int(time.time()) + 8 * 3600,
        'iat': int(time.time()),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm='HS256')


def decode_token(token):
    return jwt.decode(token, SECRET_KEY, algorithms=['HS256'])


# ── 房间管理 ──────────────────────────────────────────────────
# rooms: { doc_id: [ {'ws': ws, 'username': str} ] }
rooms: dict = {}
rooms_lock = threading.Lock()


def join_room(doc_id, ws, username):
    with rooms_lock:
        if doc_id not in rooms:
            rooms[doc_id] = []
        rooms[doc_id].append({'ws': ws, 'username': username})


def leave_room(doc_id, ws):
    with rooms_lock:
        if doc_id in rooms:
            rooms[doc_id] = [c for c in rooms[doc_id] if c['ws'] is not ws]
            if not rooms[doc_id]:
                del rooms[doc_id]


def get_room_users(doc_id):
    with rooms_lock:
        if doc_id not in rooms:
            return []
        return [c['username'] for c in rooms[doc_id]]


def broadcast(doc_id, message, exclude_ws=None):
    """向房间内所有连接广播消息（可排除发送者）"""
    with rooms_lock:
        if doc_id not in rooms:
            return
        clients = list(rooms[doc_id])

    payload = json.dumps(message, ensure_ascii=False)
    dead = []
    for client in clients:
        if client['ws'] is exclude_ws:
            continue
        try:
            client['ws'].send(payload)
        except Exception:
            dead.append(client)

    if dead:
        with rooms_lock:
            if doc_id in rooms:
                for d in dead:
                    if d in rooms[doc_id]:
                        rooms[doc_id].remove(d)


# ── 认证接口 ──────────────────────────────────────────────────
@app.route('/api/register', methods=['POST'])
def register():
    data = request.get_json(force=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    realname = (data.get('realname') or '').strip()

    if not username or not password:
        return jsonify({'error': '用户名和密码不能为空'}), 400
    if len(username) < 2 or len(username) > 30:
        return jsonify({'error': '用户名长度 2-30 个字符'}), 400
    if len(password) < 6:
        return jsonify({'error': '密码至少 6 位'}), 400

    pw_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

    try:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                'INSERT INTO users (username, password, realname) VALUES (%s, %s, %s)',
                (username, pw_hash, realname)
            )
        conn.commit()
        conn.close()
    except pymysql.err.IntegrityError:
        return jsonify({'error': '用户名已存在'}), 409

    return jsonify({'message': '注册成功'}), 201


@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json(force=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    if not username or not password:
        return jsonify({'error': '用户名和密码不能为空'}), 400

    conn = get_db()
    with conn.cursor() as cur:
        cur.execute('SELECT * FROM users WHERE username = %s', (username,))
        row = cur.fetchone()
    conn.close()

    if not row or not bcrypt.checkpw(password.encode('utf-8'), row[2].encode('utf-8')):
        return jsonify({'error': '用户名或密码错误'}), 401

    token = create_token(row[0], row[1])
    return jsonify({
        'token':    token,
        'username': row[1],
        'realname': row[3] or row[1],
    })


# ── WebSocket 协同 ────────────────────────────────────────────
@sock.route('/ws')
def collab_ws(ws):
    """
    连接时 URL 参数: ?token=<JWT>&doc_id=<文档ID>

    Client → Server 消息:
      {"type":"change",  "delta":{"position":N,"deleteCount":N,"insert":"..."}}
      {"type":"ping"}

    Server → Client 消息:
      {"type":"welcome",    "username":"...", "users":[...], "doc_id":"..."}
      {"type":"change",     "delta":{...}, "from":"username"}
      {"type":"user_join",  "username":"...", "users":[...]}
      {"type":"user_leave", "username":"...", "users":[...]}
      {"type":"error",      "message":"..."}
      {"type":"pong"}
    """
    from urllib.parse import urlparse, parse_qs
    query = parse_qs(urlparse(request.url).query)

    token_list  = query.get('token',  [])
    doc_id_list = query.get('doc_id', [])

    if not token_list or not doc_id_list:
        ws.send(json.dumps({'type': 'error', 'message': '缺少 token 或 doc_id 参数'}))
        return

    token  = token_list[0]
    doc_id = doc_id_list[0]

    # 验证 JWT
    try:
        payload  = decode_token(token)
        username = payload['username']
    except jwt.ExpiredSignatureError:
        ws.send(json.dumps({'type': 'error', 'message': 'Token 已过期，请重新登录'}))
        return
    except jwt.InvalidTokenError:
        ws.send(json.dumps({'type': 'error', 'message': '无效的 Token'}))
        return

    # 加入房间
    join_room(doc_id, ws, username)
    users = get_room_users(doc_id)

    # 欢迎消息
    ws.send(json.dumps({
        'type':     'welcome',
        'username': username,
        'users':    users,
        'doc_id':   doc_id,
    }, ensure_ascii=False))

    # 通知房间内其他人
    broadcast(doc_id, {
        'type':     'user_join',
        'username': username,
        'users':    users,
    }, exclude_ws=ws)

    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get('type')

            if msg_type == 'change':
                broadcast(doc_id, {
                    'type':  'change',
                    'delta': msg.get('delta'),
                    'from':  username,
                }, exclude_ws=ws)

            elif msg_type == 'ping':
                ws.send(json.dumps({'type': 'pong'}))

    except Exception:
        pass

    finally:
        leave_room(doc_id, ws)
        users_after = get_room_users(doc_id)
        broadcast(doc_id, {
            'type':     'user_leave',
            'username': username,
            'users':    users_after,
        })


# ── 启动 ──────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    print('=' * 45)
    print('  WPS 协同编辑服务器')
    print('  HTTP : http://0.0.0.0:5009')
    print('  WS   : ws://0.0.0.0:5009/ws')
    print('=' * 45)
    app.run(host='0.0.0.0', port=5009, debug=True, threaded=True)
