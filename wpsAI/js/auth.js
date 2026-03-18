/**
 * 认证工具（登录 / 注册 / 登出）
 * token 和用户信息使用 sessionStorage 存储（标签页级别）
 */
var Auth = (function () {

    var KEY_TOKEN    = 'collab_token'
    var KEY_USERNAME = 'collab_username'
    var KEY_REALNAME = 'collab_realname'
    var KEY_UNIT     = 'collab_unit'

    function getToken()    { return sessionStorage.getItem(KEY_TOKEN)    || '' }
    function getUsername() { return sessionStorage.getItem(KEY_USERNAME) || '' }
    function getRealname() { return sessionStorage.getItem(KEY_REALNAME) || '' }
    function getUnit()     { return sessionStorage.getItem(KEY_UNIT)     || '' }
    function isLoggedIn()  { return !!getToken() }

    function _saveSession(token, username, realname, unit) {
        sessionStorage.setItem(KEY_TOKEN,    token)
        sessionStorage.setItem(KEY_USERNAME, username)
        sessionStorage.setItem(KEY_REALNAME, realname)
        sessionStorage.setItem(KEY_UNIT,     unit || '')
    }

    function clearSession() {
        sessionStorage.removeItem(KEY_TOKEN)
        sessionStorage.removeItem(KEY_USERNAME)
        sessionStorage.removeItem(KEY_REALNAME)
        sessionStorage.removeItem(KEY_UNIT)
    }

    /**
     * 登录
     * @returns {Promise<{ok:boolean, error?:string, data?:object}>}
     */
    function login(username, password) {
        return fetch(COLLAB_CONFIG.SERVER_HTTP + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, password: password }),
        })
        .then(function (res) {
            return res.json().then(function (data) {
                if (res.ok) {
                    _saveSession(data.token, data.username, data.realname, data.unit)
                    return { ok: true, data: data }
                }
                return { ok: false, error: data.error || '登录失败' }
            })
        })
        .catch(function () {
            return { ok: false, error: '无法连接到服务器，请检查配置' }
        })
    }

    /**
     * 注册
     * @returns {Promise<{ok:boolean, error?:string}>}
     */
    function register(username, password, realname, unit) {
        return fetch(COLLAB_CONFIG.SERVER_HTTP + '/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, password: password, realname: realname, unit: unit }),
        })
        .then(function (res) {
            return res.json().then(function (data) {
                if (res.ok) return { ok: true }
                return { ok: false, error: data.error || '注册失败' }
            })
        })
        .catch(function () {
            return { ok: false, error: '无法连接到服务器，请检查配置' }
        })
    }

    return {
        login:        login,
        register:     register,
        clearSession: clearSession,
        isLoggedIn:   isLoggedIn,
        getToken:     getToken,
        getUsername:  getUsername,
        getRealname:  getRealname,
        getUnit:      getUnit,
    }
})()
