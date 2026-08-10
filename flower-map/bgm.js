/**
 * 背景音乐管理模块
 * - 循环播放背景音乐
 * - 提供右下角控制按钮，切换播放/暂停
 * - 页面首次用户交互（点击）时尝试播放，绕过浏览器自动播放限制
 * - 录像时自动暂停，录像结束恢复
 *
 * 暴露全局对象 window.BGM:
 *   BGM.play()          主动播放（需在用户手势回调中调用）
 *   BGM.pause()         主动暂停
 *   BGM.toggle()        切换播放/暂停（按钮点击触发）
 *   BGM.suspend()       录像时临时暂停（记住原状态）
 *   BGM.resume()        录像结束后恢复（若之前在播则继续播）
 *   BGM.isPlaying       当前是否在播放
 */
(function () {
  'use strict';

  var AUDIO_URL = 'https://mat1.gtimg.com/qqcdn/redian/bgm_breath_of_c.mp3';
  var DEFAULT_VOLUME = 0.4;

  var audio = new Audio(AUDIO_URL);
  audio.loop = true;
  audio.volume = DEFAULT_VOLUME;
  audio.preload = 'auto';
  // iOS Safari 需要这两个属性才能内联播放
  audio.setAttribute('playsinline', '');
  audio.setAttribute('webkit-playsinline', '');
  audio.setAttribute('x5-playsinline', '');

  var btn = null;
  var isPlaying = false;
  // 录像期间记录"录像前是否在播"，以便录完恢复
  var suspendedByRecording = false;
  var wasPlayingBeforeSuspend = false;
  // 用户是否主动暂停过（主动暂停后不应被自动恢复）
  var userPaused = false;

  function updateBtn() {
    if (!btn) return;
    if (isPlaying) {
      btn.classList.add('playing');
      btn.classList.remove('paused');
      btn.setAttribute('aria-label', '暂停背景音乐');
      btn.setAttribute('title', '暂停背景音乐');
    } else {
      btn.classList.add('paused');
      btn.classList.remove('playing');
      btn.setAttribute('aria-label', '播放背景音乐');
      btn.setAttribute('title', '播放背景音乐');
    }
  }

  function doPlay() {
    var p = audio.play();
    if (p && typeof p.then === 'function') {
      p.then(function () {
        isPlaying = true;
        userPaused = false;
        updateBtn();
      }).catch(function () {
        // 自动播放被浏览器拦截；保持暂停状态
        isPlaying = false;
        updateBtn();
      });
    } else {
      isPlaying = true;
      userPaused = false;
      updateBtn();
    }
  }

  function doPause() {
    try { audio.pause(); } catch (e) {}
    isPlaying = false;
    updateBtn();
  }

  function toggle() {
    if (isPlaying) {
      userPaused = true;
      doPause();
    } else {
      userPaused = false;
      doPlay();
    }
  }

  function suspend() {
    if (suspendedByRecording) return;
    suspendedByRecording = true;
    wasPlayingBeforeSuspend = isPlaying;
    if (isPlaying) doPause();
  }

  function resume() {
    if (!suspendedByRecording) return;
    suspendedByRecording = false;
    if (wasPlayingBeforeSuspend && !userPaused) {
      doPlay();
    }
  }

  // audio 事件同步内部状态
  audio.addEventListener('play', function () { isPlaying = true; updateBtn(); });
  audio.addEventListener('pause', function () { isPlaying = false; updateBtn(); });
  audio.addEventListener('ended', function () { isPlaying = false; updateBtn(); });

  // 注入右下角控制按钮
  function injectButton() {
    if (btn) return;
    btn = document.createElement('button');
    btn.id = 'bgm-toggle-btn';
    btn.className = 'bgm-toggle-btn paused';
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', '播放背景音乐');
    btn.setAttribute('title', '播放背景音乐');
    btn.innerHTML =
      '<span class="bgm-icon bgm-icon-playing" aria-hidden="true">' +
      '<span class="bgm-bar"></span><span class="bgm-bar"></span><span class="bgm-bar"></span>' +
      '</span>' +
      '<span class="bgm-icon bgm-icon-paused" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 9v6h4l5 5V4L7 9H3z"></path>' +
      '<line x1="16" y1="8" x2="22" y2="14"></line>' +
      '<line x1="22" y1="8" x2="16" y2="14"></line>' +
      '</svg>' +
      '</span>';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
    document.body.appendChild(btn);
    updateBtn();
  }

  // 首次用户交互时尝试播放（用户点"开始"/"一键开花"即算一次交互）
  function tryAutoplayOnFirstInteraction() {
    var fired = false;
    function handler() {
      if (fired) return;
      fired = true;
      ['click', 'touchend', 'pointerup'].forEach(function (ev) {
        document.removeEventListener(ev, handler, true);
      });
      if (!userPaused && !isPlaying) doPlay();
    }
    ['click', 'touchend', 'pointerup'].forEach(function (ev) {
      document.addEventListener(ev, handler, true);
    });
  }

  function init() {
    injectButton();
    tryAutoplayOnFirstInteraction();
    hookMediaRecorder();
  }

  /**
   * Hook MediaRecorder.prototype.start/stop，让 AR 录像时自动暂停 BGM，结束后恢复。
   * 避免音乐被录进视频里。
   */
  function hookMediaRecorder() {
    try {
      if (typeof MediaRecorder === 'undefined' || !MediaRecorder.prototype) return;
      if (MediaRecorder.prototype.__bgmHooked) return;
      MediaRecorder.prototype.__bgmHooked = true;

      var origStart = MediaRecorder.prototype.start;
      var origStop = MediaRecorder.prototype.stop;

      MediaRecorder.prototype.start = function () {
        try { suspend(); } catch (e) {}
        return origStart.apply(this, arguments);
      };
      MediaRecorder.prototype.stop = function () {
        var ret;
        try { ret = origStop.apply(this, arguments); } finally {
          // 稍微延迟一点再恢复，避免 stop 过程中抓到残音
          setTimeout(function () { try { resume(); } catch (e) {} }, 150);
        }
        return ret;
      };
    } catch (e) {
      // MediaRecorder 不可用时忽略
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.BGM = {
    play: doPlay,
    pause: doPause,
    toggle: toggle,
    suspend: suspend,
    resume: resume,
    get isPlaying() { return isPlaying; }
  };
})();
