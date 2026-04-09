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
    var _imageRegistry = []   // [{file_id, url, filename, position, img_width, img_height, deleted}]

    // ── 本地图片快照（InlineShapes 的 hash 数组，用于检测新增）
    var _lastImageHashes = []
    var _imageMissCounts = {}  // {file_id: number}，降低误判删除概率
    var _formatOpsHistory = []  // 最近格式操作历史，用于文本回退覆盖后重放
    var _lastPlainText = ''     // 最近一次已知纯文本，用于格式区间随文本位移
    var _ignoreContentChangesUntil = 0
    var _pendingImageInsertions = 0
    var _imageInsertLocks = {}  // {file_id: true}
    var _lastSentImageState = {}  // {file_id: 'position_width_height'}

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
        var cleaned = xml.replace(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g, function (runXml) {
            if (!/<w:drawing\b|<w:pict\b/.test(runXml)) return runXml

            var withoutDrawing = runXml
                .replace(/<w:drawing\b[^>]*>[\s\S]*?<\/w:drawing>/g, '')
                .replace(/<w:pict\b[^>]*>[\s\S]*?<\/w:pict>/g, '')

            var residual = withoutDrawing
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;|&#160;/g, ' ')
                .replace(/\s+/g, '')

            residual = residual
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/&amp;/g, '&')

            if (!residual || residual === '/' || residual === '\\') {
                return ''
            }
            return withoutDrawing
        })

        return cleaned
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

    function _decodeXmlEntities(text) {
        if (!text) return ''
        return String(text)
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&')
    }

    function _xmlToPlainText(xml) {
        if (!xml) return ''
        return _decodeXmlEntities(
            xml
                .replace(/<w:tab\b[^>]*\/>/g, '\t')
                .replace(/<w:br\b[^>]*\/>/g, '\n')
                .replace(/<w:cr\b[^>]*\/>/g, '\n')
                .replace(/<\/w:p>/g, '\n')
                .replace(/<[^>]+>/g, '')
        )
            .replace(/\r/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/^\n+|\n+$/g, '')
    }

    function _getSyncText() {
        var xml = _getContent()
        if (xml) return _xmlToPlainText(_stripDrawings(xml))
        return _getText()
    }

    function _refreshSyncBaseline() {
        _lastPlainText = _getSyncText()
        _lastHash = _hash(_lastPlainText)
    }

    function _suppressContentSync(ms) {
        var duration = Number(ms || 0)
        if (!isFinite(duration) || duration < 0) duration = 0
        var until = Date.now() + duration
        if (until > _ignoreContentChangesUntil) {
            _ignoreContentChangesUntil = until
        }
        _refreshSyncBaseline()
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
            var sizeNum = Number(attrs.size)
            if (attrs.bold !== undefined) range.Font.Bold = attrs.bold ? 1 : 0
            if (attrs.italic !== undefined) range.Font.Italic = attrs.italic ? 1 : 0
            if (attrs.underline !== undefined) range.Font.Underline = attrs.underline ? 1 : 0
            if (attrs.size !== undefined && isFinite(sizeNum) && sizeNum > 0) range.Font.Size = sizeNum
            if (attrs.color !== undefined) range.Font.Color = Number(attrs.color)
            if (attrs.name !== undefined && attrs.name) range.Font.Name = String(attrs.name)
            return true
        } catch (e) {
            console.error('[Sync] 应用格式操作失败', e)
            return false
        }
    }

    // ── 中文字号映射（号数 -> 磅值）──────────────────────────
    function _getCnSizeMap() {
        return {
            '初号': 42,
            '小初': 36,
            '一号': 26,
            '小一': 24,
            '二号': 22,
            '小二': 18,
            '三号': 16,
            '小三': 15,
            '四号': 14,
            '小四': 12,
            '五号': 10.5,
            '小五': 9,
            '六号': 7.5,
            '小六': 6.5,
            '七号': 5.5,
            '八号': 5,
        }
    }

    function _parseSizeValue(value) {
        var raw = String(value == null ? '' : value).trim()
        if (!raw) return NaN
        var map = _getCnSizeMap()
        if (map[raw] !== undefined) return map[raw]
        var num = Number(raw)
        return isFinite(num) ? num : NaN
    }

    function _getSizeStepsAsc() {
        return [5, 5.5, 6.5, 7.5, 9, 10.5, 12, 14, 15, 16, 18, 22, 24, 26, 36, 42]
    }

    function _resolveNextSize(currentSize, direction) {
        var steps = _getSizeStepsAsc()
        var current = Number(currentSize)
        if (!isFinite(current) || current <= 0) current = 12

        var index = 0
        var minDiff = Infinity
        for (var i = 0; i < steps.length; i++) {
            var diff = Math.abs(steps[i] - current)
            if (diff < minDiff) {
                minDiff = diff
                index = i
            }
        }

        if (direction > 0) {
            if (steps[index] <= current && index < steps.length - 1) index++
        } else if (direction < 0) {
            if (steps[index] >= current && index > 0) index--
        }

        if (index < 0) index = 0
        if (index >= steps.length) index = steps.length - 1
        return steps[index]
    }

    function _resolvePresetAttrs(preset) {
        var key = String(preset || '').trim()
        if (!key) return null
        if (key === 'title') {
            return { name: '黑体', size: 16, bold: 1 }
        }
        if (key === 'subtitle') {
            return { name: '楷体', size: 15, bold: 1 }
        }
        if (key === 'heading1') {
            return { name: '黑体', size: 14, bold: 1 }
        }
        if (key === 'heading2') {
            return { name: '黑体', size: 12, bold: 1 }
        }
        if (key === 'body') {
            return { name: '宋体', size: 12, bold: 0, italic: 0, underline: 0, color: 0 }
        }
        return null
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
            var size = _parseSizeValue(value)
            if (!isFinite(size) || size <= 0) return { error: '字号无效，请输入磅值或如“一号”' }
            attrs.size = size
        } else if (kind === 'size_delta') {
            var delta = Number(value || 0)
            if (!delta) return { error: '字号增量无效' }
            var currentSize = Number(range.Font.Size || 12)
            if (!isFinite(currentSize) || currentSize <= 0) currentSize = 12
            var nextSize = _resolveNextSize(currentSize, delta > 0 ? 1 : -1)
            attrs.size = nextSize
        } else if (kind === 'color') {
            var color = Number(value)
            if (isNaN(color)) return { error: '颜色值无效' }
            attrs.color = color
        } else if (kind === 'name') {
            var fname = String(value || '').trim()
            if (!fname) return { error: '字体名不能为空' }
            attrs.name = fname
        } else if (kind === 'preset') {
            var presetAttrs = _resolvePresetAttrs(value)
            if (!presetAttrs) return { error: '不支持的样式预设' }
            attrs = presetAttrs
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

    // ── 计算 old/new 之间的单段编辑（前后缀法）──────────────
    function _computeSingleEdit(oldText, newText) {
        oldText = oldText || ''
        newText = newText || ''
        if (oldText === newText) return null

        var oldLen = oldText.length
        var newLen = newText.length
        var prefix = 0
        while (prefix < oldLen && prefix < newLen && oldText.charAt(prefix) === newText.charAt(prefix)) {
            prefix++
        }

        var suffix = 0
        while (suffix < oldLen - prefix && suffix < newLen - prefix &&
               oldText.charAt(oldLen - 1 - suffix) === newText.charAt(newLen - 1 - suffix)) {
            suffix++
        }

        return {
            pos: prefix,
            delCount: oldLen - prefix - suffix,
            insCount: newLen - prefix - suffix,
        }
    }

    function _shiftOpByEdit(op, edit) {
        var s = Number(op.start || 0)
        var e = Number(op.end || s)
        var p = Number(edit.pos || 0)
        var delCount = Number(edit.delCount || 0)
        var insCount = Number(edit.insCount || 0)
        var delEnd = p + delCount
        var delta = insCount - delCount

        if (e <= p) {
            return op
        }
        if (s >= delEnd) {
            op.start = s + delta
            op.end = e + delta
            return op
        }

        // 与编辑区间重叠：起点被吞并到编辑点，终点按净位移修正
        var newStart = s < p ? s : p
        var newEnd = e + delta
        if (newEnd < newStart) newEnd = newStart
        op.start = newStart
        op.end = newEnd
        return op
    }

    function _shiftFormatOpsByTextDiff(oldText, newText) {
        var edit = _computeSingleEdit(oldText, newText)
        if (!edit) return
        for (var i = 0; i < _formatOpsHistory.length; i++) {
            _shiftOpByEdit(_formatOpsHistory[i], edit)
        }
    }

    function _normalizeImageMetric(value) {
        var num = Number(value || 0)
        if (!isFinite(num) || num < 0) return 0
        return Math.round(num)
    }

    function _cloneImageRecord(image) {
        if (!image) return null
        return {
            file_id:    String(image.file_id || ''),
            url:        String(image.url || ''),
            filename:   String(image.filename || ''),
            position:   _normalizeImageMetric(image.position),
            img_width:  _normalizeImageMetric(image.img_width),
            img_height: _normalizeImageMetric(image.img_height),
            deleted:    !!image.deleted,
        }
    }

    function _imageStateKey(image) {
        if (!image || !image.file_id) return ''
        return [
            _normalizeImageMetric(image.position),
            _normalizeImageMetric(image.img_width),
            _normalizeImageMetric(image.img_height),
        ].join('_')
    }

    function _markImageStateSynced(image) {
        if (!image || !image.file_id) return
        _lastSentImageState[image.file_id] = _imageStateKey(image)
    }

    function _findImageIndex(fileId) {
        for (var i = 0; i < _imageRegistry.length; i++) {
            if (_imageRegistry[i].file_id === fileId) return i
        }
        return -1
    }

    function _getImageRecord(fileId) {
        var idx = _findImageIndex(fileId)
        return idx >= 0 ? _imageRegistry[idx] : null
    }

    function _upsertImageRecord(image) {
        var record = _cloneImageRecord(image)
        if (!record || !record.file_id) return null
        var idx = _findImageIndex(record.file_id)
        if (idx >= 0) {
            var prev = _imageRegistry[idx]
            _imageRegistry[idx] = {
                file_id:    record.file_id,
                url:        record.url || prev.url,
                filename:   record.filename || prev.filename || '',
                position:   record.position,
                img_width:  record.img_width || prev.img_width,
                img_height: record.img_height || prev.img_height,
                deleted:    record.deleted,
            }
        } else {
            _imageRegistry.push(record)
        }
        _imageMissCounts[record.file_id] = 0
        return _getImageRecord(record.file_id)
    }

    function _listActiveImages() {
        var list = []
        for (var i = 0; i < _imageRegistry.length; i++) {
            if (!_imageRegistry[i].deleted) list.push(_imageRegistry[i])
        }
        list.sort(function (a, b) {
            if (a.position !== b.position) return a.position - b.position
            return String(a.file_id).localeCompare(String(b.file_id))
        })
        return list
    }

    function _shiftImagePositionByEdit(image, edit) {
        if (!image || image.deleted || !edit) return
        var pos = _normalizeImageMetric(image.position)
        var editPos = _normalizeImageMetric(edit.pos)
        var delCount = _normalizeImageMetric(edit.delCount)
        var insCount = _normalizeImageMetric(edit.insCount)
        var editEnd = editPos + delCount
        var delta = insCount - delCount

        if (pos >= editEnd) {
            pos += delta
        } else if (pos > editPos) {
            pos = editPos + insCount
        }

        if (pos < 0) pos = 0
        image.position = pos
    }

    function _shiftImageRegistryByTextDiff(oldText, newText) {
        var edit = _computeSingleEdit(oldText, newText)
        if (!edit) return
        for (var i = 0; i < _imageRegistry.length; i++) {
            _shiftImagePositionByEdit(_imageRegistry[i], edit)
        }
    }

    function _getInlineShapesInfo() {
        try {
            var doc = _boundDoc || (window.Application && window.Application.ActiveDocument)
            if (!doc || !doc.InlineShapes) return []
            var shapes = doc.InlineShapes
            var list = []
            for (var i = 1; i <= shapes.Count; i++) {
                try {
                    var shape = shapes.Item(i)
                    list.push({
                        index:    i,
                        shape:    shape,
                        position: _normalizeImageMetric(shape.Range ? shape.Range.Start : i),
                        width:    _normalizeImageMetric(shape.Width),
                        height:   _normalizeImageMetric(shape.Height),
                    })
                } catch (e) {}
            }
            list.sort(function (a, b) {
                if (a.position !== b.position) return a.position - b.position
                return a.index - b.index
            })
            return list
        } catch (e) {
            return []
        }
    }

    function _detectRuntimeOS() {
        try {
            var doc = _boundDoc || (window.Application && window.Application.ActiveDocument)
            var fullName = doc && doc.FullName ? String(doc.FullName) : ''
            if (/^[A-Za-z]:\\/.test(fullName)) return 'windows'
            if (fullName.indexOf('/') === 0) return 'mac'
        } catch (e) {}

        try {
            var platform = (window.navigator && (window.navigator.platform || window.navigator.userAgent) || '').toLowerCase()
            if (platform.indexOf('win') >= 0) return 'windows'
            if (platform.indexOf('mac') >= 0 || platform.indexOf('darwin') >= 0) return 'mac'
        } catch (e2) {}

        return 'mac'
    }

    function _escapePosixArg(value) {
        return "'" + String(value || '').replace(/'/g, "'\\''") + "'"
    }

    function _escapePowerShellArg(value) {
        return "'" + String(value || '').replace(/'/g, "''") + "'"
    }

    function _resolveImageUrl(image) {
        if (!image) return ''
        var rawUrl = String(image.url || '')
        if (!rawUrl) return ''
        return rawUrl.indexOf('http') === 0 ? rawUrl : COLLAB_CONFIG.SERVER_HTTP + rawUrl
    }

    function _getImageExtension(image) {
        var filename = image && image.filename ? String(image.filename) : ''
        var match = filename.match(/\.[A-Za-z0-9]+$/)
        if (match) return match[0].toLowerCase()

        var url = _resolveImageUrl(image)
        try {
            var clean = url.split('?')[0]
            var extMatch = clean.match(/\.[A-Za-z0-9]+$/)
            if (extMatch) return extMatch[0].toLowerCase()
        } catch (e) {}
        return '.img'
    }

    function _getCachePaths(image) {
        var fileId = image && image.file_id ? String(image.file_id) : ('img_' + Date.now())
        var ext = _getImageExtension(image)
        var osType = _detectRuntimeOS()
        if (osType === 'windows') {
            var winDir = '%TEMP%\\wpsAI\\images'
            return {
                os: osType,
                dirForShell: winDir,
                fileForShell: winDir + '\\' + fileId + ext,
                localPath: winDir.replace(/^%TEMP%/, '') ? null : null,
            }
        }
        var posixDir = '/tmp/wpsAI/images'
        return {
            os: osType,
            dirForShell: posixDir,
            fileForShell: posixDir + '/' + fileId + ext,
            localPath: posixDir + '/' + fileId + ext,
        }
    }

    function _filePathToUri(path) {
        var normalized = String(path || '')
        if (!normalized) return ''
        if (/^[A-Za-z]:\\/.test(normalized)) {
            return 'file:///' + normalized.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:')
        }
        if (normalized.indexOf('/') === 0) return 'file://' + normalized
        if (normalized.indexOf('~/') === 0) return ''
        return 'file:///' + normalized.replace(/\\/g, '/')
    }

    function _checkLocalFileReadable(path) {
        return new Promise(function (resolve) {
            var uri = _filePathToUri(path)
            if (!uri) return resolve(false)
            try {
                var xhr = new XMLHttpRequest()
                xhr.open('GET', uri, true)
                xhr.responseType = 'blob'
                xhr.onload = function () {
                    resolve(xhr.status === 200 || xhr.status === 0)
                }
                xhr.onerror = function () { resolve(false) }
                xhr.send()
            } catch (e) {
                resolve(false)
            }
        })
    }

    function _pollLocalFile(path, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var startedAt = Date.now()
            function check() {
                _checkLocalFileReadable(path).then(function (ok) {
                    if (ok) return resolve(path)
                    if (Date.now() - startedAt >= timeoutMs) return reject(new Error('图片下载超时'))
                    setTimeout(check, 250)
                })
            }
            check()
        })
    }

    function _insertRemoteImageWithCache(image) {
        if (!image) return Promise.resolve(false)
        return Promise.resolve(
            _insertImageAt(image.position, _resolveImageUrl(image), image.img_width, image.img_height)
        )
    }

    function _queueImageInsert(image) {
        if (!image) return Promise.resolve(false)
        var fileId = String(image.file_id || '')
        if (fileId && _imageInsertLocks[fileId]) return Promise.resolve(false)
        if (fileId && _findShapeForImage(fileId)) return Promise.resolve(true)
        if (fileId) _imageInsertLocks[fileId] = true
        _pendingImageInsertions++
        _suppressContentSync(4000)
        return _insertRemoteImageWithCache(image)
            .then(function (ok) {
                _lastImageHashes = _getImageHashes()
                _refreshSyncBaseline()
                return !!ok
            })
            .catch(function (e) {
                console.error('[Sync] 图片异步插入失败', e)
                return false
            })
            .finally(function () {
                _pendingImageInsertions = Math.max(0, _pendingImageInsertions - 1)
                if (fileId) delete _imageInsertLocks[fileId]
                _refreshSyncBaseline()
            })
    }

    function _buildImageShapeMap() {
        var records = _listActiveImages()
        var shapes = _getInlineShapesInfo()
        var usedShapeIndexes = {}
        var mapping = {}

        for (var i = 0; i < records.length; i++) {
            var record = records[i]
            var best = null
            var bestScore = Infinity
            for (var j = 0; j < shapes.length; j++) {
                var shapeInfo = shapes[j]
                if (usedShapeIndexes[shapeInfo.index]) continue
                var posDiff = Math.abs(shapeInfo.position - _normalizeImageMetric(record.position))
                var widthDiff = Math.abs(shapeInfo.width - _normalizeImageMetric(record.img_width))
                var heightDiff = Math.abs(shapeInfo.height - _normalizeImageMetric(record.img_height))
                var score = posDiff * 10 + widthDiff + heightDiff
                if (score < bestScore) {
                    bestScore = score
                    best = shapeInfo
                }
            }
            if (best) {
                usedShapeIndexes[best.index] = true
                mapping[record.file_id] = best
            }
        }

        return mapping
    }

    function _findShapeForImage(fileId) {
        var mapping = _buildImageShapeMap()
        return mapping[fileId] || null
    }

    function _removeShape(shape) {
        if (!shape) return false
        try {
            shape.Delete()
            return true
        } catch (e) {
            console.warn('[Sync] 删除图片失败', e)
            return false
        }
    }

    function _applyImageUpdateLocally(image) {
        if (!image || !image.file_id) return false
        var record = _upsertImageRecord(image)
        if (!record || record.deleted) return false

        _suppressContentSync(1500)

        isApplying = true
        try {
            var shapeInfo = _findShapeForImage(record.file_id)
            var needReinsert = !shapeInfo || shapeInfo.position !== record.position

            if (!needReinsert && shapeInfo && shapeInfo.shape) {
                try {
                    if (record.img_width > 0) shapeInfo.shape.Width = record.img_width
                    if (record.img_height > 0) shapeInfo.shape.Height = record.img_height
                } catch (e) {
                    needReinsert = true
                }
            }

            if (needReinsert) {
                if (shapeInfo && shapeInfo.shape) {
                    _removeShape(shapeInfo.shape)
                }
                _queueImageInsert(record)
            }

            _lastImageHashes = _getImageHashes()
            _markImageStateSynced(record)
            _refreshSyncBaseline()
            return true
        } finally {
            isApplying = false
        }
    }

    function _deleteImageLocally(fileId) {
        var record = _getImageRecord(fileId)
        if (!record || record.deleted) return false
        record.deleted = true
        var shapeInfo = _findShapeForImage(fileId)
        delete _lastSentImageState[fileId]

        _suppressContentSync(1500)

        isApplying = true
        try {
            if (shapeInfo && shapeInfo.shape) {
                _removeShape(shapeInfo.shape)
            }
            _lastImageHashes = _getImageHashes()
            _refreshSyncBaseline()
            return true
        } finally {
            isApplying = false
        }
    }

    function _sendImageOp(op, image) {
        if (!image || !image.file_id || !WSManager.connected()) return false
        if (op === 'update') {
            _markImageStateSynced(image)
        }
        return WSManager.send({
            type: 'image_op',
            op: op,
            image: {
                file_id:    image.file_id,
                url:        image.url || '',
                filename:   image.filename || '',
                position:   _normalizeImageMetric(image.position),
                img_width:  _normalizeImageMetric(image.img_width),
                img_height: _normalizeImageMetric(image.img_height),
            },
        })
    }

    function _findSelectedShapeInfo() {
        try {
            var sel = window.Application && window.Application.Selection
            if (!sel || !sel.Range) return null
            var inlineShapes = sel.Range.InlineShapes
            if (inlineShapes && inlineShapes.Count > 0) {
                var shape = inlineShapes.Item(1)
                return {
                    shape:    shape,
                    index:    0,
                    position: _normalizeImageMetric(shape.Range ? shape.Range.Start : sel.Range.Start),
                    width:    _normalizeImageMetric(shape.Width),
                    height:   _normalizeImageMetric(shape.Height),
                }
            }

            var cursor = _normalizeImageMetric(sel.Range.Start)
            var shapes = _getInlineShapesInfo()
            var best = null
            var bestDist = Infinity
            for (var i = 0; i < shapes.length; i++) {
                var dist = Math.abs(shapes[i].position - cursor)
                if (dist < bestDist) {
                    bestDist = dist
                    best = shapes[i]
                }
            }
            if (best && bestDist <= 2) return best
        } catch (e) {}
        return null
    }

    function _findImageRecordByShape(shapeInfo) {
        if (!shapeInfo) return null
        var records = _listActiveImages()
        var best = null
        var bestScore = Infinity
        for (var i = 0; i < records.length; i++) {
            var record = records[i]
            var posDiff = Math.abs(_normalizeImageMetric(record.position) - shapeInfo.position)
            var widthDiff = Math.abs(_normalizeImageMetric(record.img_width) - shapeInfo.width)
            var heightDiff = Math.abs(_normalizeImageMetric(record.img_height) - shapeInfo.height)
            var score = posDiff * 10 + widthDiff + heightDiff
            if (score < bestScore) {
                bestScore = score
                best = record
            }
        }
        return best
    }

    function _getSelectedImageContext() {
        var shapeInfo = _findSelectedShapeInfo()
        if (!shapeInfo) return null
        var record = _findImageRecordByShape(shapeInfo)
        if (!record) return null
        return {
            image: record,
            shape: shapeInfo,
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
    // 不能自动读取任意新图片字节，但可检测已同步图片的删除/移动/缩放。
    function _checkImages() {
        _lastImageHashes = _getImageHashes()
        if (isApplying || _pendingImageInsertions > 0) return

        var mapping = _buildImageShapeMap()
        var active = _listActiveImages()
        for (var i = 0; i < active.length; i++) {
            var image = active[i]
            var shapeInfo = mapping[image.file_id]
            if (!shapeInfo) {
                _imageMissCounts[image.file_id] = (_imageMissCounts[image.file_id] || 0) + 1
                // 连续多轮都找不到才判定为删除，避免 XML 覆盖/重绘期间误报。
                if (_imageMissCounts[image.file_id] < 3) continue

                image.deleted = true
                delete _lastSentImageState[image.file_id]
                _sendImageOp('delete', image)
                continue
            }

            _imageMissCounts[image.file_id] = 0

            var nextPosition = _normalizeImageMetric(shapeInfo.position)
            var nextWidth = _normalizeImageMetric(shapeInfo.width)
            var nextHeight = _normalizeImageMetric(shapeInfo.height)
            var changed = nextPosition !== image.position
                || nextWidth !== image.img_width
                || nextHeight !== image.img_height

            if (!changed) continue

            var nextState = nextPosition + '_' + nextWidth + '_' + nextHeight
            if (_lastSentImageState[image.file_id] === nextState) continue

            image.position = nextPosition
            image.img_width = nextWidth
            image.img_height = nextHeight
            _sendImageOp('update', image)
        }
    }

    // ── 轮询：检测文字变化并同步（含格式，剥离图片）──────────
    // 用 Content.Text 做变更检测（可靠），用 Content.XML 做载荷（含格式）
    // 若 Content.XML 不可用则直接发纯文本，确保在所有 WPS 版本下都能同步
    function _checkAndSync() {
        if (isApplying || _pendingAck || _pendingImageInsertions > 0) return
        _checkImages()
        var text = _getSyncText()
        if (Date.now() < _ignoreContentChangesUntil) {
            _lastPlainText = text
            _lastHash = _hash(text)
            _lastContent = text
            return
        }
        var h    = _hash(text)
        if (h !== _lastHash) {
            _shiftFormatOpsByTextDiff(_lastPlainText, text)
            _shiftImageRegistryByTextDiff(_lastPlainText, text)
            _lastPlainText = text
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
        var textAfter = ''
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
            textAfter = _getSyncText()
            _shiftFormatOpsByTextDiff(_lastPlainText, textAfter)
            _shiftImageRegistryByTextDiff(_lastPlainText, textAfter)
            _lastPlainText = textAfter
            _lastHash    = _hash(textAfter)
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
        if (_listActiveImages().length) {
            _reapplyImages()
            // 图片插入会改变文档，需重新同步哈希基准
            _lastHash = _hash(_getSyncText())
        }
    }

    // ── 用服务器快照初始化本地文档（含格式，XML 或纯文本）──────
    function initFromSnapshot(content, seq, images) {
        if (!content) {
            _lastContent = ''
            _lastPlainText = ''
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
            _lastPlainText = _getSyncText()
            _lastHash    = _hash(_lastPlainText)  // 始终基于实际文本哈希
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
        var images = _listActiveImages()
        for (var i = 0; i < images.length; i++) {
            _queueImageInsert(images[i])
        }
    }

    // ── 批量应用服务器图片列表（新成员加入时）──────────────────
    function _applyImageList(images) {
        if (!images || !images.length) return
        for (var i = 0; i < images.length; i++) {
            var img = images[i]
            if (_syncedImageIds[img.file_id]) continue
            _syncedImageIds[img.file_id] = true
            _upsertImageRecord({
                file_id:    img.file_id,
                url:        img.url,
                filename:   img.filename,
                position:   img.position,
                img_width:  img.img_width,
                img_height: img.img_height,
                deleted:    !!img.deleted,
            })
            if (img.deleted) continue
            _queueImageInsert(img)
        }
    }

    // ── 接收远程图片插入 ──────────────────────────────────────
    function applyRemoteImage(msg) {
        if (!msg || !msg.file_id) return
        if (_syncedImageIds[msg.file_id]) return
        _syncedImageIds[msg.file_id] = true
        _upsertImageRecord({
            file_id:    msg.file_id,
            url:        msg.url,
            filename:   msg.filename,
            position:   msg.position,
            img_width:  msg.img_width,
            img_height: msg.img_height,
            deleted:    false,
        })
        _queueImageInsert(msg).then(function (ok) {
            if (ok) console.log('[Sync] 远程图片已插入:', msg.file_id)
        })
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
        _lastPlainText   = _getSyncText()
        _lastHash        = _hash(_lastPlainText)  // 始终基于文本哈希，与 XML 是否可用无关
        _lastContent     = _lastPlainText
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
        _lastPlainText   = ''
        _lastHash        = 0
        isApplying       = false
        _pendingAck      = false
        _boundDoc        = null
        _syncedImageIds  = {}
        _imageRegistry   = []
        _imageMissCounts = {}
        _imageInsertLocks = {}
        _lastSentImageState = {}
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
        getLocalText:        _getSyncText,
        contentAck:          function () {
            // 服务器确认 content_update 已处理，清除发送锁，立即检测累积变更
            _pendingAck = false
            _checkAndSync()
        },
        addLocalImage:       function (fileId, url, position, w, h, filename) {
            // 上传者调用：注册本地图片，防止收到服务器广播时重复插入
            if (_syncedImageIds[fileId]) return
            _syncedImageIds[fileId] = true
            var record = _upsertImageRecord({
                file_id: fileId,
                url: url,
                filename: filename || '',
                position: position,
                img_width: w,
                img_height: h,
                deleted: false,
            })
            if (record) {
                _markImageStateSynced(record)
                _queueImageInsert(record)
            }
        },
        applyRemoteImageOp: function (msg) {
            if (!msg || !msg.op || !msg.image || !msg.image.file_id) return
            if (msg.op === 'delete') {
                _deleteImageLocally(msg.image.file_id)
                return
            }
            if (msg.op === 'update') {
                _applyImageUpdateLocally(msg.image)
            }
        },
        getSelectedImageInfo: function () {
            var ctx = _getSelectedImageContext()
            if (!ctx || !ctx.image) return null
            return {
                file_id: ctx.image.file_id,
                position: ctx.shape ? ctx.shape.position : ctx.image.position,
                img_width: ctx.shape ? ctx.shape.width : ctx.image.img_width,
                img_height: ctx.shape ? ctx.shape.height : ctx.image.img_height,
            }
        },
        syncSelectedImage: function () {
            var ctx = _getSelectedImageContext()
            if (!ctx || !ctx.image || !ctx.shape) {
                return { ok: false, error: '请先在文档中选中一张已协同的图片' }
            }
            ctx.image.position = _normalizeImageMetric(ctx.shape.position)
            ctx.image.img_width = _normalizeImageMetric(ctx.shape.width)
            ctx.image.img_height = _normalizeImageMetric(ctx.shape.height)
            _sendImageOp('update', ctx.image)
            return { ok: true, image: _cloneImageRecord(ctx.image) }
        },
        resizeSelectedImage: function (width, height) {
            var ctx = _getSelectedImageContext()
            if (!ctx || !ctx.image) {
                return { ok: false, error: '请先在文档中选中一张已协同的图片' }
            }
            var nextWidth = _normalizeImageMetric(width)
            var nextHeight = _normalizeImageMetric(height)
            if (!nextWidth || !nextHeight) {
                return { ok: false, error: '宽高必须为正整数' }
            }
            ctx.image.img_width = nextWidth
            ctx.image.img_height = nextHeight
            if (!_applyImageUpdateLocally(ctx.image)) {
                return { ok: false, error: '图片尺寸更新失败' }
            }
            _sendImageOp('update', ctx.image)
            return { ok: true, image: _cloneImageRecord(ctx.image) }
        },
        deleteSelectedImage: function () {
            var ctx = _getSelectedImageContext()
            if (!ctx || !ctx.image) {
                return { ok: false, error: '请先在文档中选中一张已协同的图片' }
            }
            if (!_deleteImageLocally(ctx.image.file_id)) {
                return { ok: false, error: '图片删除失败' }
            }
            _sendImageOp('delete', ctx.image)
            return { ok: true, image: _cloneImageRecord(ctx.image) }
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
