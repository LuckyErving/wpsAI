import os
import copy
import json
import threading
import time
from collections import deque

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
                unit     VARCHAR(100) DEFAULT '',
                created  DATETIME     DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')
        # 兼容旧表（若没有 unit 列则添加）
        try:
            cur.execute("ALTER TABLE users ADD COLUMN unit VARCHAR(100) DEFAULT '' AFTER realname")
        except pymysql.err.OperationalError:
            pass

        cur.execute('''
            CREATE TABLE IF NOT EXISTS invitations (
                id        INT          AUTO_INCREMENT PRIMARY KEY,
                doc_id    VARCHAR(255) NOT NULL,
                from_user VARCHAR(50)  NOT NULL,
                to_user   VARCHAR(50)  NOT NULL,
                status    ENUM('pending','accepted','rejected') DEFAULT 'pending',
                created   DATETIME     DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_to_user (to_user),
                INDEX idx_doc_id  (doc_id)
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
# ── 文档快照（服务器权威状态）─────────────────────────────
# 算法: Server-Authoritative Sequential Delta
# - 服务器保存每个房间的最新文档内容和操作序列号
# - 新成员加入时下发快照实现初始内容同步
# - change 到达时服务器先 apply delta 再广播带序列号的操作
# - 客户端按序列号顺序应用，天然避免乱序；冲突由服务器到达顺序决定（LWW）
# - 适合内网低并发场景（< 20 人同时编辑），实现简单且可靠
doc_snapshots: dict = {}  # {doc_id: {'content': str, 'seq': int}}
doc_snapshots_lock = threading.Lock()


def get_snapshot(doc_id):
    with doc_snapshots_lock:
        snap = doc_snapshots.get(doc_id)
        return snap if snap else {'content': '', 'seq': 0}


def update_snapshot(doc_id, delta):
    """将 delta 应用到服务器快照，返回新的序列号"""
    with doc_snapshots_lock:
        snap = doc_snapshots.get(doc_id, {'content': '', 'seq': 0})
        content = snap['content']
        pos          = max(0, int(delta.get('position',    0)))
        delete_count = max(0, int(delta.get('deleteCount', 0)))
        insert       = delta.get('insert', '')
        pos = min(pos, len(content))
        content = content[:pos] + insert + content[pos + delete_count:]
        new_seq = snap['seq'] + 1
        doc_snapshots[doc_id] = {'content': content, 'seq': new_seq}
        return new_seq


def clear_snapshot(doc_id):
    with doc_snapshots_lock:
        doc_snapshots.pop(doc_id, None)


# ── OT（操作变换）────────────────────────────────────────────
# 算法升级：支持最高 200 人并发
# 每个 change 携带 base_seq（客户端最后一次见到的服务器序列号）
# 服务器将该 delta 对 base_seq 之后已提交的所有操作做 OT 变换
# 保证无论操作到达顺序如何，最终文本一致（convergence）
#
# Transform(incoming, committed)：将 incoming 对 committed 做变换
# 支持 insert / delete / replace（deleteCount + insert 组合）

MAX_HISTORY_SIZE = 500          # 最多保留最近 500 条操作（约 30 秒@200人)
op_history: dict = {}           # {doc_id: deque([(seq, delta)])}
op_history_lock = threading.Lock()


def _transform_delta(incoming, committed):
    """
    将 `incoming` delta 对 `committed` delta（服务器先提交的）做 OT 变换。
    delta 格式: {position: int, deleteCount: int, insert: str}
    返回变换后的新 delta（不修改原对象）。
    """
    op = copy.deepcopy(incoming)
    p    = max(0, int(op.get('position',    0)))
    dc   = max(0, int(op.get('deleteCount', 0)))

    a_p      = max(0, int(committed.get('position',    0)))
    a_dc     = max(0, int(committed.get('deleteCount', 0)))
    a_ins    = committed.get('insert', '') or ''
    a_ins_ln = len(a_ins)

    # ── Step 1: 调整 committed 的删除对 incoming position 的影响 ──
    if a_dc > 0:
        a_end = a_p + a_dc
        if p >= a_end:
            # incoming 完全在 committed 删除范围之后 → 左移
            p -= a_dc
        elif p > a_p:
            # incoming 起点落在 committed 删除范围内
            overlap_in_dc = min(a_end, p + dc) - p
            dc = max(0, dc - overlap_in_dc)
            p  = a_p
        else:
            # incoming 起点在 committed 删除范围前，但范围可能重叠
            if p + dc > a_p:
                overlap = min(a_end, p + dc) - a_p
                dc = max(0, dc - overlap)

    # ── Step 2: 调整 committed 的插入对 incoming position 的影响 ──
    if a_ins_ln > 0:
        if a_p < p:
            p += a_ins_ln
        elif a_p == p:
            # 同一位置插入：服务器操作优先，客户端操作向右移
            p += a_ins_ln

    op['position']    = max(0, p)
    op['deleteCount'] = max(0, dc)
    return op


def record_op(doc_id, seq, delta):
    with op_history_lock:
        if doc_id not in op_history:
            op_history[doc_id] = deque(maxlen=MAX_HISTORY_SIZE)
        op_history[doc_id].append((seq, copy.deepcopy(delta)))


def get_ops_after(doc_id, base_seq):
    """返回 seq > base_seq 的所有操作列表（按时间顺序）。"""
    with op_history_lock:
        history = op_history.get(doc_id, deque())
        return [(s, d) for s, d in history if s > base_seq]


def clear_op_history(doc_id):
    with op_history_lock:
        op_history.pop(doc_id, None)


# ── 用户在线连接映射（推送邀请通知）──────────────────────────
# {username: set of ws}
user_connections: dict = {}
user_connections_lock = threading.Lock()


def add_user_connection(username, ws):
    with user_connections_lock:
        if username not in user_connections:
            user_connections[username] = set()
        user_connections[username].add(ws)


def remove_user_connection(username, ws):
    with user_connections_lock:
        s = user_connections.get(username)
        if s:
            s.discard(ws)
            if not s:
                del user_connections[username]


def push_to_user(username, message):
    """向某用户所有在线 WS 连接推送消息。"""
    with user_connections_lock:
        conns = list(user_connections.get(username, set()))
    if not conns:
        return
    payload = json.dumps(message, ensure_ascii=False)
    for conn in conns:
        try:
            conn.send(payload)
        except Exception:
            pass


# ── JWT 辅助 ─────────────────────────────────────────────────
def _get_current_user():
    """从 Authorization: Bearer <token> 解析 JWT，返回 payload 或 None。"""
    auth  = request.headers.get('Authorization', '')
    token = auth.replace('Bearer ', '', 1).strip()
    if not token:
        return None
    try:
        return decode_token(token)
    except Exception:
        return None
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
    unit     = (data.get('unit')     or '').strip()

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
                'INSERT INTO users (username, password, realname, unit) VALUES (%s, %s, %s, %s)',
                (username, pw_hash, realname, unit)
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
        'unit':     row[4] or '',
    })


# ── 用户列表（按单位分组）────────────────────────────────────
@app.route('/api/users', methods=['GET'])
def list_users():
    user = _get_current_user()
    if not user:
        return jsonify({'error': '未登录'}), 401

    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            'SELECT username, realname, unit FROM users ORDER BY unit, realname',
        )
        rows = cur.fetchall()
    conn.close()

    groups = {}
    for row in rows:
        uname, rname, uunit = row[0], row[1] or row[0], row[2] or '未分配单位'
        if uname == user['username']:
            continue  # 排除自己
        if uunit not in groups:
            groups[uunit] = []
        groups[uunit].append({'username': uname, 'realname': rname})

    return jsonify({
        'groups': [
            {'unit': u, 'users': groups[u]}
            for u in sorted(groups.keys())
        ]
    })


# ── 邀请接口 ──────────────────────────────────────────────────
@app.route('/api/invite', methods=['POST'])
def create_invite():
    user = _get_current_user()
    if not user:
        return jsonify({'error': '未登录'}), 401

    data      = request.get_json(force=True) or {}
    doc_id    = (data.get('doc_id') or '').strip()
    usernames = data.get('usernames') or []

    if not doc_id or not usernames:
        return jsonify({'error': '参数不完整'}), 400

    # 查询发送者真实姓名
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute('SELECT realname FROM users WHERE username=%s', (user['username'],))
        r = cur.fetchone()
    from_realname = (r[0] if r and r[0] else user['username'])

    invited = 0
    for to_user in usernames:
        to_user = (to_user or '').strip()
        if not to_user or to_user == user['username']:
            continue
        try:
            with conn.cursor() as cur:
                # 避免重复 pending 邀请
                cur.execute(
                    'SELECT id FROM invitations WHERE doc_id=%s AND from_user=%s AND to_user=%s AND status="pending"',
                    (doc_id, user['username'], to_user)
                )
                if cur.fetchone():
                    continue
                cur.execute(
                    'INSERT INTO invitations (doc_id, from_user, to_user) VALUES (%s, %s, %s)',
                    (doc_id, user['username'], to_user)
                )
                invite_id = cur.lastrowid
            conn.commit()
            invited += 1
            push_to_user(to_user, {
                'type':          'invitation',
                'invite_id':     invite_id,
                'doc_id':        doc_id,
                'from_user':     user['username'],
                'from_realname': from_realname,
            })
        except Exception:
            conn.rollback()
    conn.close()

    return jsonify({'invited': invited})


@app.route('/api/invite/<int:invite_id>/respond', methods=['POST'])
def respond_invite(invite_id):
    user = _get_current_user()
    if not user:
        return jsonify({'error': '未登录'}), 401

    data   = request.get_json(force=True) or {}
    action = data.get('action')  # 'accept' | 'reject'
    if action not in ('accept', 'reject'):
        return jsonify({'error': '无效操作'}), 400

    status = 'accepted' if action == 'accept' else 'rejected'

    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            'SELECT doc_id, from_user, status FROM invitations WHERE id=%s AND to_user=%s',
            (invite_id, user['username'])
        )
        row = cur.fetchone()

    if not row:
        conn.close()
        return jsonify({'error': '邀请不存在'}), 404
    if row[2] != 'pending':
        conn.close()
        return jsonify({'error': '邀请已处理'}), 409

    with conn.cursor() as cur:
        cur.execute('UPDATE invitations SET status=%s WHERE id=%s', (status, invite_id))
    conn.commit()
    conn.close()

    return jsonify({'ok': True, 'doc_id': row[0]})


@app.route('/api/invite/pending', methods=['GET'])
def get_pending_invites():
    user = _get_current_user()
    if not user:
        return jsonify({'error': '未登录'}), 401

    conn = get_db()
    with conn.cursor() as cur:
        cur.execute('''
            SELECT i.id, i.doc_id, i.from_user, u.realname, i.created
            FROM   invitations i
            LEFT   JOIN users u ON u.username = i.from_user
            WHERE  i.to_user = %s AND i.status = 'pending'
            ORDER  BY i.created ASC
        ''', (user['username'],))
        rows = cur.fetchall()
    conn.close()

    return jsonify({'invitations': [
        {
            'id':            r[0],
            'doc_id':        r[1],
            'from_user':     r[2],
            'from_realname': r[3] or r[2],
            'created':       str(r[4]),
        }
        for r in rows
    ]})
@sock.route('/ws')
def collab_ws(ws):
    """
    连接时 URL 参数: ?token=<JWT>&doc_id=<文档ID>

    Client → Server 消息:
      {"type":"change",  "delta":{"position":N,"deleteCount":N,"insert":"..."}, "base_seq":N}
        └─ base_seq: 客户端计算此 delta 时所基于的服务器序列号（用于 OT 变换）
      {"type":"ping"}

    Server → Client 消息:
      {"type":"welcome",    "username":"...", "users":[...], "doc_id":"...", "content":"...", "seq":N}
        └─ content/seq: 当前文档全文快照及序列号，新成员用于初始化本地内容
      {"type":"change",     "delta":{...}, "from":"username", "seq":N}
        └─ delta 已经过 OT 变换，seq 为本次操作在服务器上的序列号
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

    # 加入房间 + 注册用户在线连接
    join_room(doc_id, ws, username)
    add_user_connection(username, ws)
    users = get_room_users(doc_id)

    # 获取当前文档快照（给新成员同步内容）
    snap = get_snapshot(doc_id)

    # 欢迎消息（携带快照内容和序列号）
    ws.send(json.dumps({
        'type':     'welcome',
        'username': username,
        'users':    users,
        'doc_id':   doc_id,
        'content':  snap['content'],
        'seq':      snap['seq'],
    }, ensure_ascii=False))

    # 推送该用户尚未处理的邀请（断线重连 / 首次登录时补发）
    try:
        _conn = get_db()
        with _conn.cursor() as _cur:
            _cur.execute('''
                SELECT i.id, i.doc_id, i.from_user, u.realname
                FROM   invitations i
                LEFT   JOIN users u ON u.username = i.from_user
                WHERE  i.to_user = %s AND i.status = 'pending'
                ORDER  BY i.created ASC
            ''', (username,))
            pending = _cur.fetchall()
        _conn.close()
        for p in pending:
            ws.send(json.dumps({
                'type':          'invitation',
                'invite_id':     p[0],
                'doc_id':        p[1],
                'from_user':     p[2],
                'from_realname': p[3] or p[2],
            }, ensure_ascii=False))
    except Exception:
        pass

    # 欢迎消息（携带快照内容和序列号）
    ws.send(json.dumps({
        'type':     'welcome',
        'username': username,
        'users':    users,
        'doc_id':   doc_id,
        'content':  snap['content'],
        'seq':      snap['seq'],
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
                delta    = msg.get('delta')
                base_seq = int(msg.get('base_seq', 0))
                if delta:
                    # ── OT 变换：将 delta 对 base_seq 之后已提交的操作逐一变换 ──
                    concurrent_ops = get_ops_after(doc_id, base_seq)
                    transformed = delta
                    for _, committed in concurrent_ops:
                        transformed = _transform_delta(transformed, committed)

                    # 应用变换后的 delta 到服务器权威快照
                    seq = update_snapshot(doc_id, transformed)
                    # 记录到操作历史供后续客户端 OT 使用
                    record_op(doc_id, seq, transformed)

                    broadcast(doc_id, {
                        'type':  'change',
                        'delta': transformed,
                        'from':  username,
                        'seq':   seq,
                    }, exclude_ws=ws)

            elif msg_type == 'ping':
                ws.send(json.dumps({'type': 'pong'}))

    except Exception:
        pass

    finally:
        remove_user_connection(username, ws)
        leave_room(doc_id, ws)
        users_after = get_room_users(doc_id)
        # 房间已空则清理快照和操作历史，释放内存
        if not users_after:
            clear_snapshot(doc_id)
            clear_op_history(doc_id)
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
