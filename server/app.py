import os
import copy
import json
import threading
import time
import uuid
import hashlib
from collections import deque
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory
from flask_sock import Sock
from flask_cors import CORS
import jwt
import bcrypt
import pymysql
from dbutils.pooled_db import PooledDB

# ── 配置 ─────────────────────────────────────────────────────
SECRET_KEY = os.environ.get('SECRET_KEY', 'wps-collab-secret-please-change-in-production')
TOKEN_TTL_SECONDS = int(os.environ.get('TOKEN_TTL_SECONDS', 30 * 24 * 3600))
TOKEN_LEEWAY_SECONDS = int(os.environ.get('TOKEN_LEEWAY_SECONDS', 300))

DB_CONFIG = {
    'host':     os.environ.get('DB_HOST',     'localhost'),
    'port':     int(os.environ.get('DB_PORT', 3306)),
    'user':     os.environ.get('DB_USER',     'yyw'),
    'password': os.environ.get('DB_PASSWORD', 'yyw110'),
    'database': os.environ.get('DB_NAME',     'wps_collab'),
    'charset':  'utf8mb4',
}

# ── 图片存储配置 ───────────────────────────────────────────────
IMAGE_DIR        = Path(os.environ.get('IMAGE_DIR', './uploads/images'))
IMAGE_MAX_BYTES  = 10 * 1024 * 1024          # 10 MB
IMAGE_ALLOW_EXT  = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tiff'}

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

        cur.execute('''
            CREATE TABLE IF NOT EXISTS doc_images (
                id           INT           AUTO_INCREMENT PRIMARY KEY,
                doc_id       VARCHAR(255)  NOT NULL,
                file_id      VARCHAR(64)   NOT NULL UNIQUE,
                filename     VARCHAR(255)  NOT NULL,
                uploader     VARCHAR(50)   NOT NULL,
                position     INT           DEFAULT 0,
                insert_after_para INT      DEFAULT -1,
                img_width    INT           DEFAULT 0,
                img_height   INT           DEFAULT 0,
                is_deleted   TINYINT(1)    DEFAULT 0,
                created      DATETIME      DEFAULT CURRENT_TIMESTAMP,
                updated      DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_doc (doc_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')

        try:
            cur.execute('ALTER TABLE doc_images ADD COLUMN is_deleted TINYINT(1) DEFAULT 0 AFTER img_height')
        except pymysql.err.OperationalError:
            pass

        try:
            cur.execute(
                'ALTER TABLE doc_images ADD COLUMN updated DATETIME '
                'DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created'
            )
        except pymysql.err.OperationalError:
            pass

        # 文档历史快照（自动保存）
        cur.execute('''
            CREATE TABLE IF NOT EXISTS doc_history (
                id         INT           AUTO_INCREMENT PRIMARY KEY,
                doc_id     VARCHAR(255)  NOT NULL,
                saver      VARCHAR(50)   NOT NULL,
                content    MEDIUMTEXT    NOT NULL,
                saved_at   DATETIME      DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_doc_time (doc_id, saved_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')

        # 用户通知（邀请/加入/離开等）
        cur.execute('''
            CREATE TABLE IF NOT EXISTS notifications (
                id         INT           AUTO_INCREMENT PRIMARY KEY,
                to_user    VARCHAR(50)   NOT NULL,
                ntype      VARCHAR(30)   NOT NULL,
                content    VARCHAR(512)  NOT NULL,
                extra      VARCHAR(512)  DEFAULT '',
                is_read    TINYINT(1)    DEFAULT 0,
                created    DATETIME      DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user_read (to_user, is_read)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')
    conn.commit()
    conn.close()

    # 确保图片存储目录存在
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)


# ── JWT ──────────────────────────────────────────────────────
def create_token(user_id, username):
    now_ts = int(time.time())
    payload = {
        'user_id': user_id,
        'username': username,
        'exp': now_ts + TOKEN_TTL_SECONDS,
        'iat': now_ts,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm='HS256')


def decode_token(token):
    return jwt.decode(
        token,
        SECRET_KEY,
        algorithms=['HS256'],
        leeway=TOKEN_LEEWAY_SECONDS,
    )


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

# 文档路径缓存（记录各房间首个加入者上报的本地文件全路径）
doc_paths: dict = {}  # {doc_id: str}
doc_paths_lock = threading.Lock()


def get_doc_path(doc_id):
    with doc_paths_lock:
        return doc_paths.get(doc_id, '')


def set_doc_path(doc_id, path):
    with doc_paths_lock:
        if doc_id not in doc_paths and path:
            doc_paths[doc_id] = path


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


def _allowed_image(filename):
    return Path(filename).suffix.lower() in IMAGE_ALLOW_EXT


def _get_doc_images(doc_id):
    """从数据库取当前房间所有已同步图片列表。"""
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            'SELECT file_id, filename, uploader, position, insert_after_para, '
            '       img_width, img_height, is_deleted, created, updated '
            'FROM doc_images WHERE doc_id=%s AND is_deleted=0 ORDER BY created ASC',
            (doc_id,)
        )
        rows = cur.fetchall()
    conn.close()
    return [
        {
            'file_id':          r[0],
            'filename':         r[1],
            'uploader':         r[2],
            'position':         r[3],
            'insert_after_para':r[4],
            'img_width':        r[5],
            'img_height':       r[6],
            'deleted':          bool(r[7]),
            'url':              '/api/images/' + r[0],
            'created_at':       str(r[8]),
            'updated_at':       str(r[9]),
        }
        for r in rows
    ]


def _get_doc_image(file_id):
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            'SELECT doc_id, file_id, filename, uploader, position, insert_after_para, '
            '       img_width, img_height, is_deleted '
            'FROM doc_images WHERE file_id=%s LIMIT 1',
            (file_id,)
        )
        row = cur.fetchone()
    conn.close()
    if not row:
        return None
    return {
        'doc_id':            row[0],
        'file_id':           row[1],
        'filename':          row[2],
        'uploader':          row[3],
        'position':          row[4],
        'insert_after_para': row[5],
        'img_width':         row[6],
        'img_height':        row[7],
        'deleted':           bool(row[8]),
        'url':               '/api/images/' + row[1],
    }


def _update_doc_image_state(file_id, position=None, img_width=None, img_height=None, is_deleted=None):
    fields = []
    params = []

    if position is not None:
        fields.append('position=%s')
        params.append(int(position))
    if img_width is not None:
        fields.append('img_width=%s')
        params.append(int(img_width))
    if img_height is not None:
        fields.append('img_height=%s')
        params.append(int(img_height))
    if is_deleted is not None:
        fields.append('is_deleted=%s')
        params.append(1 if is_deleted else 0)

    if not fields:
        return False

    params.append(file_id)
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            'UPDATE doc_images SET ' + ', '.join(fields) + ' WHERE file_id=%s',
            tuple(params)
        )
    conn.commit()
    conn.close()
    return True


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
            # 同时写入通知表（离线时也能看到）
            _add_notification(
                to_user, 'invitation',
                f'{from_realname} 邀请你协作文档「{doc_id}」'
            )
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

    return jsonify({'ok': True, 'doc_id': row[0], 'doc_path': get_doc_path(row[0])})


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


# ── 图片接口 ──────────────────────────────────────────────────
@app.route('/api/upload_image', methods=['POST'])
def upload_image():
    """
    上传图片并记录到数据库。
    Form-data: file=<图片文件>, doc_id=<房间ID>, position=<字符位置>,
               insert_after_para=<段落索引>, img_width=<宽>, img_height=<高>
    """
    user = _get_current_user()
    if not user:
        return jsonify({'error': '未登录'}), 401

    if 'file' not in request.files:
        return jsonify({'error': '缺少图片文件'}), 400

    f      = request.files['file']
    doc_id = (request.form.get('doc_id') or '').strip()
    if not doc_id:
        return jsonify({'error': '缺少 doc_id'}), 400
    if not _allowed_image(f.filename or ''):
        return jsonify({'error': '不支持的图片格式'}), 400

    raw = f.read()
    if len(raw) > IMAGE_MAX_BYTES:
        return jsonify({'error': '图片超过 10MB 限制'}), 413

    # 内容验证：确保是真实图片
    try:
        from PIL import Image
        import io
        img_obj = Image.open(io.BytesIO(raw))
        img_w, img_h = img_obj.size
        img_obj.verify()
    except Exception:
        return jsonify({'error': '文件内容不是有效图片'}), 400

    ext     = Path(f.filename).suffix.lower()
    file_id = uuid.uuid4().hex
    save_path = IMAGE_DIR / (file_id + ext)
    with open(save_path, 'wb') as fp:
        fp.write(raw)

    position         = int(request.form.get('position', 0))
    insert_after_para = int(request.form.get('insert_after_para', -1))
    img_width        = int(request.form.get('img_width',  img_w))
    img_height       = int(request.form.get('img_height', img_h))

    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            'INSERT INTO doc_images '
            '(doc_id, file_id, filename, uploader, position, insert_after_para, img_width, img_height) '
            'VALUES (%s, %s, %s, %s, %s, %s, %s, %s)',
            (doc_id, file_id, f.filename, user['username'],
             position, insert_after_para, img_width, img_height)
        )
    conn.commit()
    conn.close()

    img_url = '/api/images/' + file_id

    # 仅广播给其他成员（不含上传者自己，避免上传者重复插入）
    _img_msg = json.dumps({
        'type':             'insert_image',
        'file_id':          file_id,
        'url':              img_url,
        'filename':         f.filename,
        'uploader':         user['username'],
        'position':         position,
        'insert_after_para':insert_after_para,
        'img_width':        img_width,
        'img_height':       img_height,
    }, ensure_ascii=False)
    for _entry in list(rooms.get(doc_id, [])):
        if _entry['username'] != user['username']:
            try:
                _entry['ws'].send(_img_msg)
            except Exception:
                pass

    return jsonify({
        'file_id': file_id,
        'url':     img_url,
        'filename': f.filename,
        'img_width':  img_width,
        'img_height': img_height,
    }), 201


@app.route('/api/images/<file_id>', methods=['GET'])
def serve_image(file_id):
    """异常路径 / 特殊字符验证，防止路径穿越。"""
    # file_id 只允许 hex 字符
    if not all(c in '0123456789abcdefABCDEF' for c in file_id):
        return jsonify({'error': 'invalid id'}), 400
    # 在目录中搜寻匹配的文件（任意后缀）
    matched = list(IMAGE_DIR.glob(file_id + '.*'))
    if not matched:
        return jsonify({'error': '图片不存在'}), 404
    target = matched[0]
    return send_from_directory(str(IMAGE_DIR.resolve()), target.name)


@app.route('/api/images/<doc_id>/list', methods=['GET'])
def list_doc_images(doc_id):
    """获取文档所有已同步图片列表。"""
    user = _get_current_user()
    if not user:
        return jsonify({'error': '未登录'}), 401
    images = _get_doc_images(doc_id)
    return jsonify({'images': images})


# ---------------------------------------------------------------------------
# 通知辅助函数
# ---------------------------------------------------------------------------
def _add_notification(receiver: str, ntype: str, content: str):
    """向指定用户写入一条通知，并通过 WebSocket 实时推送。"""
    try:
        db = get_db()
        with db.cursor() as cur:
            cur.execute(
                'INSERT INTO notifications (to_user, ntype, content) VALUES (%s, %s, %s)',
                (receiver, ntype, content)
            )
            notif_id = cur.lastrowid
        db.commit()
        db.close()
        push_to_user(receiver, {
            'type':    'notification',
            'id':      notif_id,
            'ntype':   ntype,
            'content': content,
        })
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 文档历史 API
# ---------------------------------------------------------------------------
@app.route('/api/doc/save', methods=['POST'])
def save_doc_history():
    """手动保存当前文档快照到历史记录。"""
    user = _get_current_user()
    if not user:
        return jsonify({'error': '未登录'}), 401
    data    = request.get_json(force=True, silent=True) or {}
    doc_id  = data.get('doc_id', '').strip()
    content = data.get('content', '')
    if not doc_id:
        return jsonify({'error': '缺少 doc_id'}), 400
    try:
        db = get_db()
        with db.cursor() as cur:
            cur.execute(
                'INSERT INTO doc_history (doc_id, saver, content) VALUES (%s, %s, %s)',
                (doc_id, user['username'], content)
            )
            cur.execute('''
                DELETE FROM doc_history WHERE doc_id=%s
                AND id NOT IN (
                    SELECT id FROM (
                        SELECT id FROM doc_history
                        WHERE doc_id=%s ORDER BY saved_at DESC LIMIT 50
                    ) AS t
                )
            ''', (doc_id, doc_id))
        db.commit()
        db.close()
        # 同步更新内存快照
        if content:
            with doc_snapshots_lock:
                s = doc_snapshots.get(doc_id, {'content': '', 'seq': 0})
                doc_snapshots[doc_id] = {'content': content, 'seq': s['seq']}
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/doc/history/all', methods=['GET'])
def list_all_doc_history():
    """列出当前用户参与过的所有文档（去重）及其最新保存时间。"""
    user = _get_current_user()
    if not user:
        return jsonify({'error': '未登录'}), 401
    try:
        db = get_db()
        with db.cursor() as cur:
            cur.execute('''
                SELECT doc_id, MAX(saved_at) AS last_saved
                FROM doc_history
                WHERE saver=%s
                GROUP BY doc_id
                ORDER BY last_saved DESC
                LIMIT 100
            ''', (user['username'],))
            rows = cur.fetchall()
        db.close()
        result = [{'doc_id': r[0], 'last_saved': str(r[1])} for r in rows]
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/doc/history/<doc_id>', methods=['GET'])
def list_doc_history(doc_id):
    """列出指定文档的历史保存列表（最新50条）。"""
    user = _get_current_user()
    if not user:
        return jsonify({'error': '未登录'}), 401
    try:
        db = get_db()
        with db.cursor() as cur:
            cur.execute('''
                SELECT id, saver, saved_at
                FROM doc_history WHERE doc_id=%s
                ORDER BY saved_at DESC LIMIT 50
            ''', (doc_id,))
            rows = cur.fetchall()
        db.close()
        result = [{'id': r[0], 'saver': r[1], 'saved_at': str(r[2])} for r in rows]
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/doc/history/entry/<int:hist_id>', methods=['GET'])
def get_doc_history_entry(hist_id):
    """获取某条历史记录的完整内容（用于恢复）。"""
    user = _get_current_user()
    if not user:
        return jsonify({'error': '未登录'}), 401
    try:
        db = get_db()
        with db.cursor() as cur:
            cur.execute(
                'SELECT doc_id, saver, content, saved_at FROM doc_history WHERE id=%s',
                (hist_id,)
            )
            row = cur.fetchone()
        db.close()
        if not row:
            return jsonify({'error': '记录不存在'}), 404
        return jsonify({
            'id':       hist_id,
            'doc_id':   row[0],
            'saver':    row[1],
            'content':  row[2],
            'saved_at': str(row[3]),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ---------------------------------------------------------------------------
# 通知 API
# ---------------------------------------------------------------------------
@app.route('/api/notifications', methods=['GET'])
def get_notifications():
    """获取当前用户的通知列表（最新50条）。"""
    user = _get_current_user()
    if not user:
        return jsonify({'error': '未登录'}), 401
    try:
        db = get_db()
        with db.cursor() as cur:
            cur.execute('''
                SELECT id, ntype, content, is_read, created
                FROM notifications WHERE to_user=%s
                ORDER BY created DESC LIMIT 50
            ''', (user['username'],))
            rows = cur.fetchall()
        db.close()
        result = [
            {'id': r[0], 'type': r[1], 'content': r[2],
             'is_read': bool(r[3]), 'created_at': str(r[4])}
            for r in rows
        ]
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/notifications/read', methods=['POST'])
def mark_notifications_read():
    """将当前用户的所有未读通知标记为已读。"""
    user = _get_current_user()
    if not user:
        return jsonify({'error': '未登录'}), 401
    try:
        db = get_db()
        with db.cursor() as cur:
            cur.execute(
                'UPDATE notifications SET is_read=1 WHERE to_user=%s AND is_read=0',
                (user['username'],)
            )
        db.commit()
        db.close()
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@sock.route('/ws')
def collab_ws(ws):
    """
    连接时 URL 参数: ?token=<JWT>&doc_id=<文档ID>

    Client → Server 消息:
      {"type":"change",  "delta":{"position":N,"deleteCount":N,"insert":"..."}, "base_seq":N}
        └─ base_seq: 客户端计算此 delta 时所基于的服务器序列号（用于 OT 变换）
            {"type":"image_op", "op":"update|delete", "image":{"file_id":"...", ...}}
      {"type":"ping"}

    Server → Client 消息:
      {"type":"welcome",    "username":"...", "users":[...], "doc_id":"...", "content":"...", "seq":N}
        └─ content/seq: 当前文档全文快照及序列号，新成员用于初始化本地内容
      {"type":"change",     "delta":{...}, "from":"username", "seq":N}
        └─ delta 已经过 OT 变换，seq 为本次操作在服务器上的序列号
            {"type":"image_op",   "op":"update|delete", "image":{...}, "from":"username"}
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

    snap   = get_snapshot(doc_id)
    images = _get_doc_images(doc_id)

    # 如果内存快照为空，尝试从数据库恢复最新存储（防止服务器重启后内容丢失）
    # 注意：仅当房间里已有其他在线用户时才恢复（说明有进行中的协作会话）。
    # 若此用户是第一个进入房间的，不从 DB 恢复，由客户端推送当前文档内容作为权威，
    # 避免历史残留内容覆盖用户正在编辑的文档。
    other_users_in_room = [u for u in users if u != username]
    if not snap['content'] and other_users_in_room:
        try:
            _hc2 = get_db()
            with _hc2.cursor() as _cur2:
                _cur2.execute(
                    'SELECT content FROM doc_history WHERE doc_id=%s ORDER BY saved_at DESC LIMIT 1',
                    (doc_id,)
                )
                _db_row = _cur2.fetchone()
            _hc2.close()
            if _db_row and _db_row[0]:
                with doc_snapshots_lock:
                    doc_snapshots[doc_id] = {'content': _db_row[0], 'seq': snap['seq']}
                snap = get_snapshot(doc_id)
        except Exception:
            pass

    # 欢迎消息（携带快照内容、序列号、已同步图片列表）
    ws.send(json.dumps({
        'type':     'welcome',
        'username': username,
        'users':    users,
        'doc_id':   doc_id,
        'content':  snap['content'],
        'seq':      snap['seq'],
        'images':   images,
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

                    # 向发送者回送 ack，带上服务器确认的 seq。
                    # 否则发送者的 _lastSeq 永远为 0，导致每次都对全量历史序列做 OT 变换，
                    # 位置偏移不断累积，广播给其他客户端的 delta position 越来越大。
                    ws.send(json.dumps({'type': 'change_ack', 'seq': seq}))

            elif msg_type == 'auto_save':
                # 客户端定期上传文档内容到服务器保存
                save_content = msg.get('content', '')
                if save_content:
                    # ① 无论 DB 是否成功，先更新内存快照（这是最关键的一步）
                    #    确保首次入房时服务器能立即持有完整文档，后续 delta 才能
                    #    正确应用，以及后来者能拿到完整内容。
                    with doc_snapshots_lock:
                        _s = doc_snapshots.get(doc_id, {'content': '', 'seq': 0})
                        doc_snapshots[doc_id] = {'content': save_content, 'seq': _s['seq']}
                # ② 异步写入数据库（含 55 秒/人的节流，不影响内存已更新的快照）
                try:
                    _sc = get_db()
                    with _sc.cursor() as _scur:
                        _scur.execute('''
                            INSERT INTO doc_history (doc_id, saver, content)
                            SELECT %s, %s, %s FROM DUAL
                            WHERE NOT EXISTS (
                                SELECT 1 FROM doc_history
                                WHERE doc_id=%s AND saver=%s
                                  AND saved_at > DATE_SUB(NOW(), INTERVAL 55 SECOND)
                            ) LIMIT 1
                        ''', (doc_id, username, save_content, doc_id, username))
                        _scur.execute('''
                            DELETE FROM doc_history WHERE doc_id=%s
                            AND id NOT IN (
                                SELECT id FROM (
                                    SELECT id FROM doc_history
                                    WHERE doc_id=%s ORDER BY saved_at DESC LIMIT 50
                                ) AS t
                            )
                        ''', (doc_id, doc_id))
                    _sc.commit()
                    _sc.close()
                    ws.send(json.dumps({'type': 'save_ack', 'ok': True}))
                except Exception as _e:
                    ws.send(json.dumps({'type': 'save_ack', 'ok': False, 'error': str(_e)}))

            elif msg_type == 'register_path':
                # 客户端上报当前文档的完整本地路径，供被邀请者打开文档使用
                path = (msg.get('path') or '').strip()
                if path:
                    set_doc_path(doc_id, path)

            elif msg_type == 'content_update':
                # 客户端推送完整 XML 内容（含格式），广播给其他成员并更新服务器快照
                xml = msg.get('xml', '')
                if xml:
                    with doc_snapshots_lock:
                        snap = doc_snapshots.get(doc_id, {'content': '', 'seq': 0})
                        new_seq = snap['seq'] + 1
                        doc_snapshots[doc_id] = {'content': xml, 'seq': new_seq}
                    broadcast(doc_id, {
                        'type': 'content_update',
                        'xml':  xml,
                        'from': username,
                    }, exclude_ws=ws)
                ws.send(json.dumps({'type': 'content_ack'}))

            elif msg_type == 'get_snapshot':
                # 客户端主动请求最新快照（用于解决竞态：welcome 为空时延迟重试）
                _snap  = get_snapshot(doc_id)
                _imgs  = _get_doc_images(doc_id)
                ws.send(json.dumps({
                    'type':    'snapshot',
                    'content': _snap['content'],
                    'seq':     _snap['seq'],
                    'images':  _imgs,
                }, ensure_ascii=False))

            elif msg_type == 'format_op':
                # 插件内显式格式操作：稳定、可控，优先作为格式协同主链路
                op = msg.get('op') or {}
                if op:
                    broadcast(doc_id, {
                        'type': 'format_op',
                        'op': op,
                        'from': username,
                    }, exclude_ws=ws)

            elif msg_type == 'image_op':
                op_name = (msg.get('op') or '').strip()
                image = msg.get('image') or {}
                file_id = (image.get('file_id') or '').strip()
                if op_name not in ('update', 'delete') or not file_id:
                    continue

                current = _get_doc_image(file_id)
                if not current or current['doc_id'] != doc_id:
                    ws.send(json.dumps({
                        'type': 'error',
                        'message': '图片不存在或不属于当前文档',
                    }, ensure_ascii=False))
                    continue

                position = int(image.get('position', current['position'] or 0))
                img_width = int(image.get('img_width', current['img_width'] or 0))
                img_height = int(image.get('img_height', current['img_height'] or 0))

                if op_name == 'delete':
                    _update_doc_image_state(file_id, is_deleted=True)
                    payload = {
                        'type': 'image_op',
                        'op': 'delete',
                        'image': {
                            'file_id': file_id,
                            'url': current['url'],
                            'filename': current['filename'],
                            'position': current['position'],
                            'img_width': current['img_width'],
                            'img_height': current['img_height'],
                        },
                        'from': username,
                    }
                else:
                    _update_doc_image_state(
                        file_id,
                        position=position,
                        img_width=img_width,
                        img_height=img_height,
                        is_deleted=False,
                    )
                    payload = {
                        'type': 'image_op',
                        'op': 'update',
                        'image': {
                            'file_id': file_id,
                            'url': current['url'],
                            'filename': current['filename'],
                            'position': position,
                            'img_width': img_width,
                            'img_height': img_height,
                        },
                        'from': username,
                    }

                broadcast(doc_id, payload, exclude_ws=ws)
                ws.send(json.dumps({
                    'type': 'image_op_ack',
                    'op': op_name,
                    'file_id': file_id,
                }, ensure_ascii=False))

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
