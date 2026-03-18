/**
 * 文档同步核心
 * - 定时轮询检测本地文档变更（文字），发送 delta 到服务器
 * - 定时轮询检测本地新插入图片，上传到服务器后广播给其他人
 * - 接收远程 delta，应用到本地文档
 * - 接收远程图片事件，在本地文档对应位置插入图片
 * - 操作锁防止"回响"（远程写入触发本地变更误报）
 */
var DocSync = (function () {
    var pollingTimer   = null
    var autoSaveTimer  = null
    var _lastContent   = ''     // 上一次已同步的文档 XML 内容（含格式）
    var _lastHash      = 0      // _lastContent 的哈希，用于快速变更检测
    var isApplying     = false  // 操作锁，防止应用远程内容时触发本地变更检测
    var _pendingAck    = false  // 等待服务器 content_ack，期间暂不发送新更新
    var _boundDoc      = null   // 绑定的文档对象，避免 ActiveDocument 随焦点切换
    var POLL_INTERVAL  = 500    // ms（XML 较大，适当降低轮询频率）
    var AUTO_SAVE_INTERVAL = 60000  // 60 s

    // ── 已同步图片集合（file_id set，防止重复插入）────────────
    var _syncedImageIds = {}  // {file_id: true}

    // ── 已知图片注册表，在 applyRemoteContent 覆盖文档后重新插入
    var _imageRegistry = []   // [{file_id, url, position, img_width, img_height}]

    // ── 本地图片快照（InlineShapes 的 hash 数组，用于检测新增）
    var _lastImageHashes = []
    var _formatOpsHistory = []  // 最近格式操作历史，用于文本回退覆盖后重放

    // ── 简单哈希（djb2），用于快速检测文档内容变化 ────────────
    function _hash(str) {
        var h = 5381
        for (var i = 0; i < str.length; i++) {
            h = ((h << 5) + h) + str.charCodeAt(i)
            h = h & h
        }
        return h
    }

    // ── 剥离 XML 中的图片元素（drawing/pict）────────────────────
    // XML 同步只负责文字和格式；图片通过独立的 insert_image 机制同步
    function _stripDrawings(xml) {
        if (!xml) return xml
        return xml
            .replace(/<w:drawing\b[^>]*>[\s\S]*?<\/w:drawing>/g, '')
            .replace(/<w:pict\b[^>]*>[\s\S]*?<\/w:pict>/g, '')
    }

    // ── 获取文档 XML 内容（含格式信息）────────────────────────
    // 若 WPS 不支持 Content.XML 则返回 ''
    function _getContent() {
        try {
            var doc = _boundDoc || (window.Application && window.Application.ActiveDocument)
            if (!doc) return ''
            var xml = doc.Content.XML
            if (typeof xml !== 'string' || xml === '') return ''
            return xml
        } catch (e) { return '' }
    }

    // ── 获取文档纯文本（仅用于判断文档是否为空）────────────────
    function _getText() {
        try {
            var doc = _boundDoc || (window.Application && window.Application.ActiveDocument)
            if (!doc) return ''
            var text = doc.Content.Text || ''
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
            var doc = _boundDoc || (window.Application && window.Application.ActiveDocument)
            if (!doc) return 0
            var sel = window.Application && window.Application.Selection
            return sel ? sel.Range.Start : 0
        } catch (e) { return 0 }
    }

    function _getSelectionRangeInfo() {
        try {
            var sel = window.Application && window.Application.Selection
            if (!sel || !sel.Range) return null
            var start = Number(sel.Range.Start || 0)
            var end = Number(sel.Range.End || start)
            if (end <= start) return null
            return { start: start, end: end }
        } catch (e) {
            return null
        }
    }

    function _applyFormatOp(op) {
        if (!op) return false
        try {
            var doc = _boundDoc || (window.Application && window.Application.ActiveDocument)
            if (!doc) return false
            var start = Number(op.start || 0)
            var end = Number(op.end || start)
            if (end <= start) return false
            var range = doc.Range(start, end)
            if (!range || !range.Font) return false
            var attrs = op.charAttrs || {}
            if (attrs.bold !== undefined) range.Font.Bold = attrs.bold ? 1 : 0
            if (attrs.italic !== undefined) range.Font.Italic = attrs.italic ? 1 : 0
            if (attrs.underline !== undefined) range.Font.Underline = attrs.underline ? 1 : 0
            if (attrs.size !== undefined && Number(attrs.size) > 0) range.Font.Size = Number(attrs.size)
            if (attrs.color !== undefined) range.Font.Color = Number(attrs.color)
            if (attrs.name !== undefined && attrs.name) range.Font.Name = String(attrs.name)
            return true
        } catch (e) {
            console.error('[Sync] 应用格式操作失败', e)
            return false
        }
    }

    function _buildFormatOp(kind, value) {
        var sel = _getSelectionRangeInfo()
        if (!sel) return { error: '请先选中文本后再设置格式' }

        var doc = _boundDoc || (window.Application && window.Application.ActiveDocument)
        if (!doc) return { error: '当前没有活动文档' }
        var range = doc.Range(sel.start, sel.end)
        if (!range || !range.Font) return { error: '当前选区不支持格式设置' }

        var attrs = {}
        if (kind === 'bold') {
            attrs.bold = range.Font.Bold ? 0 : 1
        } else if (kind === 'italic') {
            attrs.italic = range.Font.Italic ? 0 : 1
        } else if (kind === 'underline') {
            attrs.underline = range.Font.Underline ? 0 : 1
        } else if (kind === 'size') {
            var size = Number(value)
            if (!size || size <= 0) return { error: '字号必须大于 0' }
            attrs.size = size
        } else if (kind === 'color') {
            var color = Number(value)
            if (isNaN(color)) return { error: '颜色值无效' }
            attrs.color = color
        } else if (kind === 'name') {
            var fname = String(value || '').trim()
            if (!fname) return { error: '字体名不能为空' }
            attrs.name = fname
        } else {
            return { error: '不支持的格式操作' }
        }

        return {
            start: sel.start,
            end: sel.end,
            charAttrs: attrs,
        }
    }

    function _recordFormatOp(op) {
        if (!op) return
        _formatOpsHistory.push({
            start: Number(op.start || 0),
            end: Number(op.end || 0),
            charAttrs: op.charAttrs || {},
        })
        // 控制历史长度，避免内存增长
        if (_formatOpsHistory.length > 500) {
            _formatOpsHistory.splice(0, _formatOpsHistory.length - 500)
        }
    }

    function _reapplyFormatOps() {
        if (!_formatOpsHistory.length) return
        for (var i = 0; i < _formatOpsHistory.length; i++) {
            _applyFormatOp(_formatOpsHistory[i])
        }
    }

    // ── 获取当前文档 InlineShapes 哈希列表（图片检测用）────────
    // 使用图片宽度+高度+段落索引做简单指纹，WPS 无法直接读取图片字节
    function _getImageHashes() {
        try {
            var doc = _boundDoc || (window.Application && window.Application.ActiveDocument)
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
            var doc = _boundDoc || (window.Application && window.Application.ActiveDocument)
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

    // ── 轮询：检测文字变化并同步（含格式，剥离图片）──────────
    // 用 Content.Text 做变更检测（可靠），用 Content.XML 做载荷（含格式）
    // 若 Content.XML 不可用则直接发纯文本，确保在所有 WPS 版本下都能同步
    function _checkAndSync() {
        if (isApplying || _pendingAck) return
        var text = _getText()
        var h    = _hash(text)
        if (h !== _lastHash) {
            _lastHash    = h
            _lastContent = text
            _pendingAck  = true
            var xml = _getContent()               // 尝试取 XML（含格式）
            var stripped = xml ? _stripDrawings(xml) : ''
            WSManager.send({
                type: 'content_update',
                xml:  stripped || text,           // XML 优先，不可用时退化为纯文本
            })
        }
        // 图片变更由 insert_image 机制单独处理，不在此轮询
    }

    // ── 接收并应用远程内容（可能是 XML 或纯文本）───────────────
    // WPS 支持 Content.XML 时保留格式；否则退回到 Content.Text
    function applyRemoteContent(content) {
        if (!content) return
        var usedPlainFallback = false
        isApplying = true
        try {
            var doc = _boundDoc || (window.Application && window.Application.ActiveDocument)
            if (!doc) return
            var isXml = content.charAt(0) === '<'  // 粗判断：XML 以 '<' 开头
            var applied = false
            if (isXml) {
                try {
                    doc.Content.XML = content
                    applied = true
                } catch (e) {
                    console.warn('[Sync] Content.XML 设置失败，退回纯文本', e)
                }
            }
            if (!applied) {
                // 退回：去掉所有 XML 标签只保留文本
                var plain = isXml ? content.replace(/<[^>]+>/g, '') : content
                var r = doc.Content
                r.Text = plain
                usedPlainFallback = true
            }
            // 用实际读回的文本更新哈希，保证后续轮询基准一致
            _lastHash    = _hash(_getText())
            _lastContent = content
        } catch (e) {
            console.error('[Sync] 应用远程内容失败', e)
        } finally {
            isApplying = false
        }

        if (usedPlainFallback) {
            // 文本回退会抹掉字符格式，重放最近格式操作。
            isApplying = true
            try { _reapplyFormatOps() } finally { isApplying = false }
        }

        // XML 覆盖文档后重新插入本地已知图片
        if (_imageRegistry.length) {
            _reapplyImages()
            // 图片插入会改变文档，需重新同步哈希基准
            _lastHash = _hash(_getText())
        }
    }

    // ── 用服务器快照初始化本地文档（含格式，XML 或纯文本）──────
    function initFromSnapshot(content, seq, images) {
        if (!content) {
            _lastContent = ''
            _lastHash    = _hash('')
            _applyImageList(images)
            return
        }
        isApplying = true
        try {
            var doc = _boundDoc || (window.Application && window.Application.ActiveDocument)
            if (doc) {
                var isXml   = content.charAt(0) === '<'
                var applied = false
                if (isXml) {
                    try { doc.Content.XML = content; applied = true } catch (e) {}
                }
                if (!applied) {
                    var plain = isXml ? content.replace(/<[^>]+>/g, '') : content
                    doc.Content.Text = plain
                }
            }
            _lastContent = content
            _lastHash    = _hash(_getText())  // 始终基于实际文本哈希
            console.log('[Sync] 已从服务器初始化文档，长度:', content.length)
        } catch (e) {
            console.error('[Sync] 初始化快照失败', e)
        } finally {
            isApplying = false
        }
        _applyImageList(images)
    }

    // ── 重新插入注册表中所有已知图片（XML 同步覆盖文档后恢复）────
    function _reapplyImages() {
        isApplying = true
        try {
            for (var i = 0; i < _imageRegistry.length; i++) {
                var img     = _imageRegistry[i]
                var fullUrl = img.url.indexOf('http') === 0
                    ? img.url
                    : COLLAB_CONFIG.SERVER_HTTP + img.url
                _insertImageAt(img.position, fullUrl, img.img_width, img.img_height)
            }
            _lastImageHashes = _getImageHashes()
        } finally {
            isApplying = false
        }
    }

    // ── 批量应用服务器图片列表（新成员加入时）──────────────────
    function _applyImageList(images) {
        if (!images || !images.length) return
        for (var i = 0; i < images.length; i++) {
            var img = images[i]
            if (_syncedImageIds[img.file_id]) continue
            _syncedImageIds[img.file_id] = true
            _imageRegistry.push({
                file_id:    img.file_id,
                url:        img.url,
                position:   img.position,
                img_width:  img.img_width,
                img_height: img.img_height,
            })
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
        _imageRegistry.push({
            file_id:    msg.file_id,
            url:        msg.url,
            position:   msg.position,
            img_width:  msg.img_width,
            img_height: msg.img_height,
        })
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

    // ── 自动保存（定期向服务器发送当前文档 XML 内容，剥离图片）──
    function _doAutoSave() {
        var xml = _stripDrawings(_getContent())  // 服务器快照只含文字+格式
        if (!xml) return
        WSManager.send({ type: 'auto_save', content: xml })
    }

    // ── 首次加入时推送本地文档 XML 作为服务器初始快照 ────────────
    function pushInitialContent() {
        var xml = _stripDrawings(_getContent())  // 同上，剥离图片
        if (!xml) return
        console.log('[Sync] 推送本地文档 XML 作为初始快照，长度:', xml.length)
        WSManager.send({ type: 'auto_save', content: xml })
    }

    // ── 开始同步 ──────────────────────────────────────────────
    function start(docObj) {
        _pendingAck      = false   // 重置：防止重连时旧 ack 未到导致永久卡死
        _boundDoc        = docObj || (window.Application && window.Application.ActiveDocument) || null
        _lastHash        = _hash(_getText())  // 始终基于文本哈希，与 XML 是否可用无关
        _lastContent     = _getText()
        _lastImageHashes = _getImageHashes()
        if (pollingTimer)  clearInterval(pollingTimer)
        if (autoSaveTimer) clearInterval(autoSaveTimer)
        pollingTimer  = setInterval(_checkAndSync, POLL_INTERVAL)
        autoSaveTimer = setInterval(_doAutoSave,   AUTO_SAVE_INTERVAL)
        console.log('[Sync] 文档同步已启动，绑定文档:', _boundDoc ? (_boundDoc.Name || 'ok') : 'ActiveDocument',
                    '，XML支持:', _getContent() !== '' ? '是' : '否')
    }

    // ── 停止同步 ──────────────────────────────────────────────
    function stop() {
        if (pollingTimer)  { clearInterval(pollingTimer);  pollingTimer  = null }
        if (autoSaveTimer) { clearInterval(autoSaveTimer); autoSaveTimer = null }
        _lastContent     = ''
        _lastHash        = 0
        isApplying       = false
        _pendingAck      = false
        _boundDoc        = null
        _syncedImageIds  = {}
        _imageRegistry   = []
        _lastImageHashes = []
        _formatOpsHistory = []
        console.log('[Sync] 文档同步已停止')
    }

    function isRunning() {
        return pollingTimer !== null
    }

    return {
        start:               start,
        stop:                stop,
        applyRemoteContent:  applyRemoteContent,
        applyRemoteImage:    applyRemoteImage,
        initFromSnapshot:    initFromSnapshot,
        uploadLocalImage:    uploadLocalImage,
        pushInitialContent:  pushInitialContent,
        isRunning:           isRunning,
        getLocalText:        _getText,
        contentAck:          function () {
            // 服务器确认 content_update 已处理，清除发送锁，立即检测累积变更
            _pendingAck = false
            _checkAndSync()
        },
        addLocalImage:       function (fileId, url, position, w, h) {
            // 上传者调用：注册本地图片，防止收到服务器广播时重复插入
            if (_syncedImageIds[fileId]) return
            _syncedImageIds[fileId] = true
            _imageRegistry.push({ file_id: fileId, url: url, position: position, img_width: w, img_height: h })
            _lastImageHashes = _getImageHashes()
        },
        applyLocalFormat:    function (kind, value) {
            var op = _buildFormatOp(kind, value)
            if (op.error) return { ok: false, error: op.error }
            isApplying = true
            try {
                if (!_applyFormatOp(op)) {
                    return { ok: false, error: '格式应用失败' }
                }
                _recordFormatOp(op)
            } finally {
                isApplying = false
            }
            if (WSManager.connected()) {
                WSManager.send({ type: 'format_op', op: op })
            }
            return { ok: true }
        },
        applyRemoteFormatOp: function (msg) {
            if (!msg || !msg.op) return
            isApplying = true
            try {
                if (_applyFormatOp(msg.op)) {
                    _recordFormatOp(msg.op)
                }
            } finally {
                isApplying = false
            }
        },
    }
})()
