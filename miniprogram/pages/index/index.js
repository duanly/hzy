// 首页：wx.login 换取小程序 code -> 服务端换 token -> 拼到 H5 url 上，用 web-view 打开。
const { API, H5_URL } = require('../../config.js');

Page({
  data: {
    webviewSrc: '',
    loadError: '',
  },

  onLoad() {
    this.loginAndLoad();
  },

  retry() {
    this.setData({ loadError: '' });
    this.loginAndLoad();
  },

  loginAndLoad() {
    wx.login({
      success: (loginRes) => {
        if (!loginRes.code) {
          this.setData({ loadError: '未获取到登录凭证 code' });
          return;
        }
        this.exchangeToken(loginRes.code);
      },
      fail: (err) => {
        console.error('[wx.login fail]', err);
        this.setData({ loadError: '微信登录失败，请重试' });
      },
    });
  },

  exchangeToken(code) {
    wx.request({
      url: `${API}/api/auth/wechat`,
      method: 'POST',
      data: { code, source: 'mp' },
      header: { 'content-type': 'application/json' },
      success: (res) => {
        const token = res.data && res.data.token;
        if (res.statusCode === 200 && token) {
          const src = `${H5_URL}/?token=${encodeURIComponent(token)}&platform=mp`;
          this.setData({ webviewSrc: src });
        } else {
          console.error('[exchangeToken bad response]', res);
          this.setData({ loadError: '登录换取 token 失败' });
        }
      },
      fail: (err) => {
        console.error('[exchangeToken fail]', err);
        this.setData({ loadError: '网络请求失败，请检查网络' });
      },
    });
  },

  // H5 内通过 wx.miniProgram.postMessage 发来的消息，会在 web-view 后退/分享/onUnload 等时机触发
  onWebviewMessage(e) {
    console.log('[web-view message]', e.detail && e.detail.data);
    // 预留：如需处理 H5 -> 小程序 的自定义消息（例如分享、返回首页等），在此扩展。
  },

  onWebviewError(e) {
    console.error('[web-view error]', e.detail);
    this.setData({ loadError: 'H5 页面加载失败' });
  },
});
