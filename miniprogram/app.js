// 小程序入口：跑胡子 web-view 壳，不做业务逻辑，登录/跳转逻辑在 pages/index/index.js。
App({
  onLaunch() {
    // 预留：可在此做小程序级别的初始化（如错误上报）。
  },

  onError(err) {
    console.error('[app onError]', err);
  },
});
