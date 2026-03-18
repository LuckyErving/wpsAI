/**
 * WebSocket 管理器
 * 功能：连接、断线自动重连、发送消息、处理消息回调
 */
var WSManager = (function () {
    var ws = null
    var reconnectTimer = null
    var isConnected = false
    var manualClose = false  // 主动断开时不重连

    var _token   = ''
    var _docId   = ''
    var _onMsg   = null
    var _onOpen  = null
    var _onClose = null

    var RECONNECT_DELAY = 3000

    function connect(token, docId, callbacks) {
        _token   = token
        _docId   = docId
        _onMsg   = callbacks.onMessage || function () {}
        _onOpen  = callbacks.onOpen    || function () {}
        _onClose = callbacks.onClose   || function () {}
        manualClose = false
        _doConnect()
    }

    function _doConnect() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = null
        }

        var url = COLLAB_CONFIG.SERVER_WS + '/ws?token=' +
                  encodeURIComponent(_token) + '&doc_id=' +
                  encodeURIComponent(_docId)

        try {
            ws = new WebSocket(url)
        } catch (e) {
            console.error('[WS] 无法创建连接', e)
            _scheduleReconnect()
            return
        }

        ws.onopen = function () {
            isConnected = true
            console.log('[WS] 已连接')
            _onOpen()
        }

        ws.onmessage = function (evt) {
            try {
                var msg = JSON.parse(evt.data)
                _onMsg(msg)
            } catch (e) {
                console.error('[WS] 消息解析失败', e)
            }
        }

        ws.onclose = function () {
            isConnected = false
            console.log('[WS] 连接断开')
            _onClose()
            if (!manualClose) {
                _scheduleReconnect()
            }
        }

        ws.onerror = function (e) {
            console.error('[WS] 错误', e)
        }
    }

    function _scheduleReconnect() {
        if (reconnectTimer || manualClose) return
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null
            if (_token && _docId) {
                console.log('[WS] 重连中...')
                _doConnect()
            }
        }, RECONNECT_DELAY)
    }

    function send(msgObj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msgObj))
            return true
        }
        return false
    }

    function disconnect() {
        manualClose = true
        _token  = ''
        _docId  = ''
        if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = null
        }
        if (ws) {
            ws.onclose = null  // 主动关闭，不触发重连逻辑
            ws.close()
            ws = null
        }
        isConnected = false
    }

    function connected() {
        return isConnected
    }

    return {
        connect:    connect,
        send:       send,
        disconnect: disconnect,
        connected:  connected,
    }
})()
