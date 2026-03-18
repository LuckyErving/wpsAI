/**
 * 文档同步核心
 * - 定时轮询检测本地文档变更，发送 delta 到服务器
 * - 接收远程 delta，应用到本地文档
 * - 操作锁防止"回响"（远程写入触发本地变更误报）
 */
var DocSync = (function () {
    var pollingTimer  = null
    var lastSnapshot  = ''
    var isApplying    = false  // 操作锁
    var POLL_INTERVAL = 300    // ms

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
        if (current === lastSnapshot) return

        var delta = _computeDelta(lastSnapshot, current)
        lastSnapshot = current

        // 无实际变化时不发送
        if (delta.deleteCount === 0 && delta.insert === '') return

        WSManager.send({ type: 'change', delta: delta })
    }

    // ── 接收并应用远程 delta ──────────────────────────────────
    function applyRemote(delta) {
        if (!delta) return
        isApplying = true
        try {
            _applyDelta(delta)
            // 更新快照，避免轮询误判为本地变更
            lastSnapshot = _getText()
        } finally {
            isApplying = false
        }
    }

    // ── 开始同步 ──────────────────────────────────────────────
    function start() {
        lastSnapshot = _getText()
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
        lastSnapshot = ''
        isApplying   = false
        console.log('[Sync] 文档同步已停止')
    }

    function isRunning() {
        return pollingTimer !== null
    }

    return {
        start:       start,
        stop:        stop,
        applyRemote: applyRemote,
        isRunning:   isRunning,
    }
})()
