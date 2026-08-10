/**
 * 多平台分享功能（参考 txnews-share v3.0.0）
 *
 * 自动识别环境（腾讯新闻App / 微信 / QQ / 普通浏览器），调用对应分享接口
 * 使用方式：window.setShare({ title, desc, imgUrl, link })
 */
(function () {
  // ============================================
  // 环境判断
  // ============================================
  function ua(toLowerCase) {
    var s = navigator.userAgent || '';
    return toLowerCase ? s.toLowerCase() : s;
  }
  function isWorkWeixin() { return /wxwork/gi.test(ua()); }
  function isWeixin()     { return /MicroMessenger/i.test(ua(true)) && !isWorkWeixin(); }
  function isQQNews()     { return /qqnews/i.test(ua(true)); }

  // ============================================
  // 腾讯新闻分享（QNJSAPI SDK）
  // ============================================
  window.initShare = function (config) {
    var desc = config.desc || config.content || '';
    if (!window.QNJSAPI) {
      console.warn('[share] QNJSAPI 未加载，腾讯新闻分享不可用');
      return;
    }
    return window.QNJSAPI.ensureJsBridgeReady()
      .then(function () {
        return window.QNJSAPI.setActionBtnStyle({ type: 1 }); // type:1 显示分享按钮
      })
      .then(function () {
        return window.QNJSAPI.setShareInfo({
          title: config.title,
          longTitle: config.longTitle || config.title,
          content: desc,
          url: config.link || config.url || window.location.href,
          imgUrl: config.imgUrl
        });
      })
      .catch(function (err) {
        console.warn('[share] QNJSAPI 调用失败：', err);
      });
  };

  window.hideShareButton = function () {
    if (!window.QNJSAPI) return;
    return window.QNJSAPI.ensureJsBridgeReady().then(function () {
      return window.QNJSAPI.setActionBtnStyle({ type: 0 });
    });
  };

  // ============================================
  // 微信分享（WeixinJSBridge，无需后端签名）
  // ============================================
  window.initWxShare = function (config) {
    var shareData = {
      title:  config.title,
      desc:   config.desc || config.content || '',
      link:   config.link || config.url || window.location.href,
      imgUrl: config.imgUrl
    };
    function onBridgeReady() {
      window.WeixinJSBridge.on('menu:share:timeline', function () {
        window.WeixinJSBridge.invoke('shareTimeline', {
          img_url: shareData.imgUrl,
          img_width: '160', img_height: '160',
          link: shareData.link, desc: shareData.desc, title: shareData.title
        });
      });
      window.WeixinJSBridge.on('menu:share:appmessage', function () {
        window.WeixinJSBridge.invoke('sendAppMessage', {
          img_url: shareData.imgUrl,
          link: shareData.link, desc: shareData.desc, title: shareData.title
        });
      });
    }
    if (window.WeixinJSBridge) {
      onBridgeReady();
    } else {
      document.addEventListener('WeixinJSBridgeReady', onBridgeReady, false);
    }
  };

  // ============================================
  // QQ / 通用浏览器分享（Meta + 腾讯开放平台 share.js）
  // ============================================
  function setMetaTag(property, content) {
    if (!content) return;
    var meta = document.querySelector('meta[property="' + property + '"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('property', property);
      document.head.appendChild(meta);
    }
    meta.content = content;
  }
  function loadScript(url, callback) {
    var s = document.createElement('script');
    s.src = url;
    s.onload = s.onerror = callback || function () {};
    document.head.appendChild(s);
  }

  window.initQQShare = function (config) {
    var shareData = {
      title:  config.title,
      desc:   config.desc || config.content || '',
      link:   config.link || config.url || window.location.href,
      imgUrl: config.imgUrl
    };
    setMetaTag('og:title',       shareData.title);
    setMetaTag('og:description', shareData.desc);
    setMetaTag('og:image',       shareData.imgUrl);
    setMetaTag('og:url',         shareData.link);

    function doSetShareInfo() {
      if (window.setShareInfo) {
        window.setShareInfo({
          title: shareData.title,
          summary: shareData.desc,
          pic: shareData.imgUrl,
          url: shareData.link
        });
      }
    }
    if (window.setShareInfo) {
      doSetShareInfo();
    } else {
      loadScript('https://qzonestyle.gtimg.cn/qzone/qzact/common/share/share.js', doSetShareInfo);
    }
  };

  // ============================================
  // 统一入口（自动判断环境）
  // ============================================
  window.setShare = function (config) {
    if (isQQNews()) {
      window.initShare(config);
    } else if (isWeixin()) {
      window.initWxShare(config);
    } else {
      window.initQQShare(config);
    }
  };
})();
