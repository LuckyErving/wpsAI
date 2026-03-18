/**
 * 文档同步核心
 * - 定时轮询检测本地文档变更（文字），发送 delta 到服务器
 * - 定时轮询检测本地新插入图片，上传到服务器后广播给其他人
 * - 接收远程 delta，应用到本地文档
 * - 接收远程图片事件，在本地文档对应位置插入图片
 * - 操作锁防止"回响"（远程写入触发本地变更误报）
 */
var DocSync = (function () {
    var pollingTimer  = null
    var lastSnapshot  = ''
    var isApplying    = false  // 操作锁
    var _lastSeq      = 0      // 最后一次从服务器收到的序列号，发送 change 时带上以支持 OT
    var POLL_INTERVAL = 300    // ms

    // ── 已同步图片集合（file_id set，防止重复插入）────────────
    var _syncedImageIds = {}  // {file_id: true}

    // ── 本地图片快照（InlineShapes 的 hash 数组，用于检测新增）
    var _lastImageHashes = []

    // ── 获取文档纯文本 ─────────────────────────────────────────
    function _getText() {
        try {
            var doc = window.Application && window.Application.ActiveDocument
            if (!doc) return ''
            var text = doc.Content.Text || ''
            // WPS 文档末尾始终有一个段落标记 \r，去掉以便比较
            if (text.length > 0 && text.charAt(text.length - 1) === '\r') {
                text = text.slice(0, -1)
            }
            return text
        } catch (e) {
            return ''
        }
    }

    // ── 获取光标（Selection）所在字符位置 ─────────────────────
    function _getCursorPosition() {
        try {
            var sel = window.Application && window.Application.Selection
            return sel ? sel.Range.Start : 0
        } catch (e) { return 0 }
    }

    // ── 获取当前文档 InlineShapes 哈希列表（图片检测用）────────
    // 使用图片宽度+高度+段落索引做简单指纹，WPS 无法直接读取图片字节
    function _getImageHashes() {
        try {
            var doc = window.Application && window.Application.ActiveDocument
            if (!doc) return []
            var shapes = doc.InlineShapes
            if (!shapes) return []
            var list = []
            for (var i = 1; i <= shapes.Count; i++) {
                try {
                    var s = shapes.Item(i)
                    // 用 Range.Start + 宽 + 高 作为指纹
                    var hash = (s.Range ? s.Range.Start : i) + '_' + (s.Width || 0) + '_' + (s.Height || 0)
                    list.push(hash)
                } catch (e) {}
            }
            return list
        } catch (e) { return [] }
    }

    // ── 将图片插入到 WPS 文档指定位置 ─────────────────────────
    // position: 字符偏移量（Range.Start）
    // imgUrl:   绝对 HTTP URL，WPS 支持 http:// 链接图片
    // w/h:      目标宽高（磅，0=自动）
    function _insertImageAt(position, imgUrl, w, h) {
        try {
            var doc = window.Application && window.Application.ActiveDocument
            if (!doc) return false
            var range  = doc.Range(position, position)
            var shapes = doc.InlineShapes
            var shape  = shapes.AddPicture(imgUrl, false, true, range)
            if (w && w > 0) shape.Width  = w
            if (h && h > 0) shape.Height = h
            return true
        } catch (e) {
            console.error('[Sync] 插入图片失败', e)
            return false
        }
    }

    // ── 检测新增本地图片并上传 ─────────────────────────────────
    // 注意：WPS JSA 无法直接读取 InlineShape 的原始字节流。
    // 实际工作流：用户先在 WPS 本地插入图片 → 插件通过"插入图片"按钮
    // 弹出文件选择对话框获取本地路径 → 读取文件 → 上传。
    // 不能自动检测本地插入（WPS JSA 限制），改为按钮触发上传。
    function _checkImages() {
        var current = _getImageHashes()
        if (current.length === _lastImageHashes.length) return
        _lastImageHashes = current
        // 图片数量变化说明有本地操作（删除或插入），仅作日志
        console.log('[Sync] 本地图片数量变化，当前:', current.length)
    }

    // ── 计算最小 delta（前缀/后缀裁剪算法）────────────────────
    function _computeDelta(oldText, newText) {
        var s = 0
        while (s < oldText.length && s < newText.length &&
               oldText.charAt(s) === newText.charAt(s)) {
            s++
        }
        var oldEnd = oldText.length
        var newEnd = newText.length
        while (oldEnd > s && newEnd > s &&
               oldText.charAt(oldEnd - 1) === newText.charAt(newEnd - 1)) {
            oldEnd--
            newEnd--
        }
        return {
            position:    s,
            deleteCount: oldEnd - s,
            insert:      newText.slice(s, newEnd),
        }
    }

    // ── 将 delta 应用到 WPS 文档 ──────────────────────────────
    function _applyDelta(delta) {
        try {
            var doc = window.Application && window.Application.ActiveDocument
            if (!doc) return

            // 计算删除范围终点（加上末尾 \r 偏移）
            var rangeEnd = delta.position + delta.deleteCount
            var range = doc.Range(delta.position, rangeEnd)

            if (delta.insert) {
                range.Text = delta.insert
            } else {
                range.Delete()
            }

            // 触发 WPS 重绘（WPS 已知的必要 workaround）
            try {
                var sel = window.Application.Selection.Range
                if (sel) sel.Select()
            } catch (e) {}

        } catch (e) {
            console.error('[Sync] 应用 delta 失败', e)
        }
    }

    // ── 轮询：检查并同步 ──────────────────────────────────────
    function _checkAndSync() {
        if (isApplying) return  // 正在应用远程变更，跳过本轮
        var current = _getText()
        if (current !== lastSnapshot) {
            var delta = _computeDelta(lastSnapshot, current)
            lastSnapshot = current
            if (delta.deleteCount !== 0 || delta.insert !== '') {
                WSManager.send({ type: 'change', delta: delta, base_seq: _lastSeq })
            }
        }
        _checkImages()
    }

    // ── 接收并应用远程 delta ──────────────────────────────────
    function applyRemote(delta, seq) {
        if (!delta) return
        if (seq !== undefined && seq !== null) _lastSeq = seq
        isApplying = true
        try {
            _applyDelta(delta)
            // 更新快照，避免轮询误判为本地变更
            lastSnapshot = _getText()
        } finally {
            isApplying = false
        }
    }

    // ── 用服务器快照初始化本地文档 ──────────────────────
    function initFromSnapshot(content, seq, images) {
        // seq 必须先更新，即使内容为空也要记录
        if (seq !== undefined && seq !== null) _lastSeq = seq
        if (content === undefined || content === null) {
            // 即使没有文字内容也要处理图片
            _applyImageList(images)
            return
        }
        if (content === '') {
            lastSnapshot = ''
            _applyImageList(images)
            return
        }
        isApplying = true
        try {
            var currentText = _getText()
            if (currentText !== content) {
                var doc = window.Application && window.Application.ActiveDocument
                if (doc) {
                    var range = doc.Range(0, currentText.length)
                    range.Text = content
                }
            }
            lastSnapshot = content
            console.log('[Sync] 已从服务器初始化文字内容，seq=' + seq + '，长度:' + content.length)
        } catch (e) {
            console.error('[Sync] 初始化快照失败', e)
        } finally {
            isApplying = false
        }
        _applyImageList(images)
    }

    // ── 批量应用服务器图片列表（新成员加入时）──────────────────
    function _applyImageList(images) {
        if (!images || !images.length) return
        for (var i = 0; i < images.length; i++) {
            var img = images[i]
            if (_syncedImageIds[img.file_id]) continue
            _syncedImageIds[img.file_id] = true
            var fullUrl = COLLAB_CONFIG.SERVER_HTTP + img.url
            _insertImageAt(img.position, fullUrl, img.img_width, img.img_height)
        }
        _lastImageHashes = _getImageHashes()
    }

    // ── 接收远程图片插入 ──────────────────────────────────────
    function applyRemoteImage(msg) {
        if (!msg || !msg.file_id) return
        if (_syncedImageIds[msg.file_id]) return
        _syncedImageIds[msg.file_id] = true
        isApplying = true
        try {
            var fullUrl = COLLAB_CONFIG.SERVER_HTTP + msg.url
            _insertImageAt(msg.position, fullUrl, msg.img_width, msg.img_height)
            _lastImageHashes = _getImageHashes()
            console.log('[Sync] 远程图片已插入:', msg.file_id)
        } finally {
            isApplying = false
        }
    }

    // ── 上传本地图片（由"插入图片"按钮主动触发）────────────────
    // localPath: 本地文件路径字符串（WPS 文件选择框返回）
    // docId: 当前房间号
    // 成功后记录 file_id，防止收到自己的广播时重复插入
    function uploadLocalImage(localPath, docId) {
        if (!window.File || !localPath) return Promise.reject('无效路径')
        var position = _getCursorPosition()

        // WPS JSA 中可通过 XMLHttpRequest 读取本地文件
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest()
            xhr.open('GET', 'file:///' + localPath.replace(/\\/g, '/'), true)
            xhr.responseType = 'blob'
            xhr.onload = function () {
                if (xhr.status !== 200 && xhr.status !== 0) {
                    return reject('读取文件失败')
                }
                var blob = xhr.response
                var filename = localPath.split(/[\\/]/).pop()
                var formData = new FormData()
                formData.append('file', blob, filename)
                formData.append('doc_id', docId)
                formData.append('position', position)

                var upload = new XMLHttpRequest()
                upload.open('POST', COLLAB_CONFIG.SERVER_HTTP + '/api/upload_image')
                upload.setRequestHeader('Authorization', 'Bearer ' + Auth.getToken())
                upload.onload = function () {
                    try {
                        var res = JSON.parse(upload.responseText)
                        if (upload.status === 201) {
                            // 标记为已同步，收到广播时不重复插入
                            _syncedImageIds[res.file_id] = true
                            _lastImageHashes = _getImageHashes()
                            resolve(res)
                        } else {
                            reject(res.error || '上传失败')
                        }
                    } catch (e) { reject('响应解析失败') }
                }
                upload.onerror = function () { reject('网络错误') }
                upload.send(formData)
            }
            xhr.onerror = function () { reject('读取本地文件失败') }
            xhr.send()
        })
    }

    // ── 开始同步 ──────────────────────────────────────────────
    function start() {
        lastSnapshot     = _getText()
        _lastImageHashes = _getImageHashes()
        if (pollingTimer) clearInterval(pollingTimer)
        pollingTimer = setInterval(_checkAndSync, POLL_INTERVAL)
        console.log('[Sync] 文档同步已启动')
    }

    // ── 停止同步 ──────────────────────────────────────────────
    function stop() {
        if (pollingTimer) {
            clearInterval(pollingTimer)
            pollingTimer = null
        }
        lastSnapshot     = ''
        isApplying       = false
        _syncedImageIds  = {}
        _lastImageHashes = []
        console.log('[Sync] 文档同步已停止')
    }

    function isRunning() {
        return pollingTimer !== null
    }

    return {
        start:            start,
        stop:             stop,
        applyRemote:      applyRemote,
        applyRemoteImage: applyRemoteImage,
        initFromSnapshot: initFromSnapshot,
        uploadLocalImage: uploadLocalImage,
        isRunning:        isRunning,
    }
})()
