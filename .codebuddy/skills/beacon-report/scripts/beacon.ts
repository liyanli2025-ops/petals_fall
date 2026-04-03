/**
 * 灯塔上报模块
 * 提供页面加载时自动上报展示/曝光的能力
 * 自动加载灯塔 SDK，无需手动引入
 */

// ============ 类型定义 ============

/** Beacon 配置 */
export interface BeaconConfig {
  /** 活动ID，必填 */
  activityId: string;
  /** 灯塔 appkey，可选，默认使用腾讯新闻 appkey */
  appkey?: string;
  /** 项目版本 */
  versionCode?: string;
  /** 渠道 */
  channelID?: string;
  /** 用户 openid */
  openid?: string;
  /** 严苛模式，上线请关闭 */
  strictMode?: boolean;
  /** 延迟上报时间(毫秒) */
  delay?: number;
}

declare global {
  interface Window {
    BeaconAction: any;
    BEACON_REPORT_CACHE?: Record<string, any>;
  }
}

// ============ 工具函数 ============

const noop = () => {};

/** 获取 Cookie */
const getCookie = (name: string): string => {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : '';
};

/** 获取 URL 参数 */
const getUrlParam = (url: string, name: string): string => {
  const reg = new RegExp('(^|&)' + name + '=([^&]*)(&|$)');
  const search = url.split('?')[1] || '';
  const match = search.match(reg);
  return match ? decodeURIComponent(match[2]) : '';
};

/** 判断是否在腾讯新闻 App 内 */
const isQQNews = (): boolean => /qqnews/i.test(navigator.userAgent);

/** 判断是否在微信内 */
const isWeixin = (): boolean => /MicroMessenger/i.test(navigator.userAgent);

/** 判断是否在 QQ 内 */
const isQQ = (): boolean => /\sQQ\//i.test(navigator.userAgent);

/** 判断是否在 QQ 浏览器内 */
const isQQBrowser = (): boolean => /MQQBrowser/i.test(navigator.userAgent) && !isQQ();

// ============ SDK 加载 ============

const BEACON_SDK_URL = 'https://beaconcdn.qq.com/sdk/3.3.1/beacon_web.min.js';
let sdkLoadPromise: Promise<void> | null = null;

/** 动态加载灯塔 SDK */
const loadBeaconSDK = (): Promise<void> => {
  // 已加载
  if (window.BeaconAction) {
    return Promise.resolve();
  }

  // 正在加载中，返回同一个 Promise
  if (sdkLoadPromise) {
    return sdkLoadPromise;
  }

  sdkLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = BEACON_SDK_URL;
    script.async = true;
    script.onload = () => {
      if (window.BeaconAction) {
        resolve();
      } else {
        reject(new Error('SDK 加载成功但 BeaconAction 不可用'));
      }
    };
    script.onerror = () => {
      reject(new Error('灯塔 SDK 加载失败'));
    };
    document.head.appendChild(script);
  });

  return sdkLoadPromise;
};

// ============ 默认配置 ============

/** 默认 appkey（腾讯新闻） */
const DEFAULT_APPKEY = 'JS03W1ML3L0KIW';

// ============ Beacon 实例 ============

let beaconInstance: any = null;
let currentActivityId = '';

/** 获取打开环境 */
const getOpenEnv = (): string => {
  if (isQQNews()) return 'news';
  if (isQQ()) return 'qq';
  if (isWeixin()) return 'wx';
  if (isQQBrowser()) return 'qqBrowser';
  return 'browser';
};

/** 获取渠道来源 */
const getOpenFrom = (): string => {
  return getUrlParam(window.location.href, 'ADTAG') || 'unknown';
};

/** 获取基础上报参数 */
const getBaseParams = (): Record<string, any> => {
  if (window.BEACON_REPORT_CACHE) {
    return window.BEACON_REPORT_CACHE;
  }

  const baseParams: Record<string, any> = {
    openEnv: getOpenEnv(),
    openFrom: getOpenFrom(),
    pageUrl: window.location.href,
    referrer: document.referrer || '',
    timestamp: Date.now(),
    activityId: currentActivityId,
  };

  // 尝试获取用户信息
  const openid = getCookie('openid') || getCookie('open_openid');
  if (openid) {
    baseParams.openid = openid;
  }

  const uin = getCookie('uin');
  if (uin) {
    baseParams.qquin = uin;
  }

  window.BEACON_REPORT_CACHE = baseParams;
  return baseParams;
};

/**
 * 初始化灯塔并自动上报页面曝光
 * @param config 配置项（activityId 必填）
 */
export const initBeaconAndReport = (config: BeaconConfig): void => {
  const { activityId, appkey = DEFAULT_APPKEY, versionCode = '1.0.0', channelID = 'h5', openid = '', strictMode = false, delay = 1000 } = config;

  if (!activityId) {
    console.error('[Beacon] activityId 不能为空');
    return;
  }

  currentActivityId = activityId;

  const doReport = () => {
    try {
      beaconInstance = new window.BeaconAction({
        appkey,
        versionCode,
        channelID,
        openid,
        strictMode,
        delay,
        sessionDuration: 60 * 1000,
        onReportSuccess: noop,
        onReportFail: noop,
      });

      // 自动上报页面曝光
      const baseParams = getBaseParams();
      beaconInstance.onUserAction('news_h5_common_view', baseParams);
    } catch (error) {
      console.error('[Beacon] 初始化失败:', error);
    }
  };

  // 加载 SDK 并上报
  loadBeaconSDK()
    .then(doReport)
    .catch((error) => {
      console.error('[Beacon]', error.message);
    });
};
