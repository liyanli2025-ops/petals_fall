// report.js - 灯塔数据埋点（花开地图 PV/UV + 点击上报）
(function() {
  var ACTIVITY_ID = 'flower_map';
  var APPKEY = 'JS03W1ML3L0KIW';
  var SDK_URL = 'https://beaconcdn.qq.com/sdk/3.3.1/beacon_web.min.js';

  var beaconInstance = null;

  // 获取 Cookie
  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : '';
  }

  // 获取 URL 参数
  function getUrlParam(name) {
    var reg = new RegExp('(^|&)' + name + '=([^&]*)(&|$)');
    var search = window.location.search.substr(1);
    var match = search.match(reg);
    return match ? decodeURIComponent(match[2]) : '';
  }

  // 获取打开环境
  function getOpenEnv() {
    var ua = navigator.userAgent;
    if (/qqnews/i.test(ua)) return 'news';
    if (/\sQQ\//i.test(ua)) return 'qq';
    if (/MicroMessenger/i.test(ua)) return 'wx';
    if (/MQQBrowser/i.test(ua)) return 'qqBrowser';
    return 'browser';
  }

  // 获取基础上报参数
  function getBaseParams(extra) {
    var params = {
      activityId: ACTIVITY_ID,
      openEnv: getOpenEnv(),
      openFrom: getUrlParam('ADTAG') || 'unknown',
      pageUrl: window.location.href,
      referrer: document.referrer || '',
      timestamp: Date.now()
    };
    var openid = getCookie('openid') || getCookie('open_openid');
    if (openid) params.openid = openid;
    var uin = getCookie('uin');
    if (uin) params.qquin = uin;
    if (extra) {
      for (var k in extra) {
        if (extra.hasOwnProperty(k)) params[k] = extra[k];
      }
    }
    return params;
  }

  // 初始化 Beacon 实例
  function getBeacon() {
    if (beaconInstance) return beaconInstance;
    try {
      beaconInstance = new window.BeaconAction({
        appkey: APPKEY,
        versionCode: '1.0.0',
        channelID: 'h5',
        strictMode: false,
        delay: 1000
      });
    } catch (e) {
      console.error('[Beacon] 初始化失败:', e);
    }
    return beaconInstance;
  }

  // 页面曝光上报（PV/UV）
  function reportView() {
    try {
      var beacon = getBeacon();
      if (beacon) {
        beacon.onUserAction('news_h5_common_view', getBaseParams());
        console.log('[Beacon] 页面曝光已上报');
      }
    } catch (e) {
      console.error('[Beacon] 曝光上报失败:', e);
    }
  }

  // 点击上报
  function reportClick(eventCode) {
    try {
      var beacon = getBeacon();
      if (beacon) {
        beacon.onUserAction('news_h5_common_click', getBaseParams({ eventCode: eventCode }));
        console.log('[Beacon] 点击已上报:', eventCode);
      }
    } catch (e) {
      console.error('[Beacon] 点击上报失败:', e);
    }
  }

  // 暴露给外部调用（供 app.js 手动上报自定义事件）
  window.__flowerMapReport = {
    click: reportClick,
    view: reportView
  };

  // 绑定按钮点击上报
  function bindClickReport() {
    // 一键开花（进入地图）
    var btnEnter = document.getElementById('btn-enter');
    if (btnEnter) {
      btnEnter.addEventListener('click', function() {
        reportClick('enterBtn');
      });
    }

    // 开启花雨（进入 AR 场景）
    var btnPetalRain = document.getElementById('btn-petal-rain');
    if (btnPetalRain) {
      btnPetalRain.addEventListener('click', function() {
        // 按钮 disabled 时不上报
        if (btnPetalRain.disabled) return;
        reportClick('petalRainBtn');
      });
    }

    // 拍照按钮
    var btnPhoto = document.getElementById('btn-photo');
    if (btnPhoto) {
      btnPhoto.addEventListener('click', function() {
        reportClick('photoBtn');
      });
    }

    // 录像按钮
    var btnRecord = document.getElementById('btn-record');
    if (btnRecord) {
      btnRecord.addEventListener('click', function() {
        reportClick('recordBtn');
      });
    }

    // 翻转摄像头
    var btnSwitchCamera = document.getElementById('btn-switch-camera');
    if (btnSwitchCamera) {
      btnSwitchCamera.addEventListener('click', function() {
        reportClick('switchCameraBtn');
      });
    }

    // 风起按钮
    var btnWind = document.getElementById('btn-wind');
    if (btnWind) {
      btnWind.addEventListener('click', function() {
        reportClick('windBtn');
      });
    }
  }

  // 加载 SDK 并执行上报
  function init() {
    if (window.BeaconAction) {
      reportView();
      bindClickReport();
      return;
    }
    var script = document.createElement('script');
    script.src = SDK_URL;
    script.onload = function() {
      reportView();
      bindClickReport();
    };
    script.onerror = function() {
      console.error('[Beacon] SDK 加载失败');
    };
    document.head.appendChild(script);
  }

  // 页面加载完成后执行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
