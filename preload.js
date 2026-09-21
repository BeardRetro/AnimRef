const {
  ipcRenderer,
  contextBridge,
  ipcMain
} = require('electron')
const fs = require('fs')
const nodePath = require('path')
const { execFile } = require('child_process')

// Audio is deliberately restricted to files already on disk: this app must not
// become a way to pull audio off the internet. A path only counts as audio if it
// has an audio extension AND exists locally, so a remote URL (which can reach the
// media pipeline via the clipboard paste path in main.js) can never become audio.
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']
function isLocalAudioFile(p) {
  if (typeof p !== 'string' || !p) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return false // reject any URL outright
  const lower = p.toLowerCase()
  if (!AUDIO_EXTENSIONS.some(ext => lower.endsWith(ext))) return false
  try { return fs.existsSync(p) } catch (e) { return false }
}

function makeTrack(p) {
  return {
    path: p,
    name: p.replace(/^.*[\\/]/, ''),
    loopStart: 0,
    loopEnd: 100
  }
}

const os = require('os')
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.avif', '.webp', '.svg', '.bmp', '.tiff', '.tif']
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.avif': 'image/avif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.tiff': 'image/tiff', '.tif': 'image/tiff'
}
function imageExt(p) {
  const m = String(p).toLowerCase().match(/\.[a-z0-9]+$/)
  return m && IMAGE_EXTENSIONS.includes(m[0]) ? m[0] : null
}
// Browsers drop images as throwaway files under the OS temp dir, which get
// cleaned up and break the reference. Detect that so those can be inlined.
function isEphemeralPath(p) {
  try {
    const real = fs.realpathSync(p)
    const tmp = fs.realpathSync(os.tmpdir())
    if (real === tmp || real.startsWith(tmp + '/')) return true
  } catch (e) { /* fall through to string checks */ }
  return /(\/mozDraggedFiles\/|\/var\/folders\/|\/T\/|\/tmp\/|\/Temp\/|\/Caches\/)/i.test(String(p))
}
// Read an image into a self-contained data URL so it survives even if the source
// file is deleted. Same storage shape as pasted images already use.
function inlineImageFile(p) {
  const ext = imageExt(p) || '.png'
  const mime = IMAGE_MIME[ext] || 'image/png'
  return 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64')
}

// HEIC/HEIF cannot be displayed at all: the pixels are HEVC-encoded and Chromium
// ships no HEVC image decoder, so it fails from a file path, from a data URL, and
// through Electron's own nativeImage. macOS decodes it via ImageIO, which the
// built-in `sips` tool exposes, so convert to JPEG first and embed that. This
// applies to every HEIC regardless of where it came from, since even a permanent
// local one would never render.
const HEIC_EXTENSIONS = ['.heic', '.heif']
function isHeicPath(p) {
  const m = String(p).toLowerCase().match(/\.[a-z0-9]+$/)
  return !!(m && HEIC_EXTENSIONS.includes(m[0]))
}
function convertHeicToDataUrl(p) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      return reject(new Error('HEIC needs macOS (sips) to decode'))
    }
    const out = nodePath.join(
      require('os').tmpdir(),
      'animref-heic-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jpg'
    )
    // quality 90: these are reference images, and lossless PNG from a phone photo
    // would bloat the scene file enormously.
    execFile('/usr/bin/sips',
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', p, '--out', out],
      (err) => {
        try {
          if (!fs.existsSync(out)) return reject(err || new Error('sips produced no output'))
          const b64 = fs.readFileSync(out).toString('base64')
          try { fs.unlinkSync(out) } catch (e) {}
          resolve('data:image/jpeg;base64,' + b64)
        } catch (e) { reject(e) }
      })
  })
}

// macOS: add a draggable strip along the top edge so the window can be moved
// normally (in addition to right-drag). It is attached to <html> as a sibling
// of <body> so the canvas pan/zoom transform on <body> can't move it.
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div')
    bar.id = 'macTitlebar'
    const title = document.createElement('span')
    title.id = 'macTitlebarText'
    bar.appendChild(title)
    document.documentElement.appendChild(bar)
    updateTitle()
  })
}

const addEvent = function (el, type, fn) {
  if (el.addEventListener)
    el.addEventListener(type, fn, false);
  else
    el.attachEvent('on' + type, fn);
};

const extend = function (obj, ext) {
  for (var key in ext)
    if (ext.hasOwnProperty(key))
      obj[key] = ext[key];
  return obj;
};

const interact = require('./interact.min.js')
let state = {
  mode: 'init', // 'init', 'standard', 'edit-video'
  editVideo: {

  },
  currentScale: 1,
  translate: {
    translateX: 0,
    translateY: 0
  },
  elements: [

  ],
  workspaceRect: {
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0
  }
}

let videoExample = {
  loopPairs: [[0, 119], [44, 56]], // can derive A, B, C & color coding from index
  activeLoopPair: 0
}
// --- Current-document model -------------------------------------------------
// Tracks which file is open and whether it has unsaved changes. Drives smart
// save (save vs save-as), the title-bar filename, and the unsaved-changes
// asterisk. Dirtiness is derived by comparing a signature of the scene's
// elements (paths/positions/sizes/loops/order) against the last-saved snapshot,
// which excludes pan/zoom — panning around isn't an "edit".
let currentFilePath = null
let isDirty = false
let isLoading = false
let lastSavedSignature = '[]'

function sceneSignature() {
  try {
    return JSON.stringify(state.elements.map(e => {
      const p = e.path || ''
      return {
        t: e.type, x: e.x, y: e.y, w: e.width, h: e.height,
        // Long inline data URLs are represented by length + a short prefix rather
        // than the whole blob, so this (run every 400ms) stays cheap now that
        // dropped images can be many MB of inlined base64.
        p: p.length > 128 ? p.length + ':' + p.slice(0, 48) : p,
        lp: e.loopPairs, al: e.activeLoopPair, at: e.activeTrack,
        tr: e.tracks && e.tracks.map(t => (t.path || '').length + ':' + (t.path || '').slice(0, 40) + ':' + t.loopStart + '-' + t.loopEnd)
      }
    }))
  } catch (err) {
    return 'sig-error-' + state.elements.length
  }
}

function documentName() {
  if (!currentFilePath) return 'Untitled'
  return currentFilePath.replace(/^.*[\\/]/, '').replace(/\.purgif$/i, '')
}

function updateTitle() {
  const label = documentName() + (isDirty ? ' *' : '')
  const el = document.getElementById('macTitlebarText')
  if (el) el.textContent = label
  document.title = label + ' — AnimRef'
  ipcRenderer.send('doc-state', { name: documentName(), isDirty: isDirty, filePath: currentFilePath })
}

// Called when the scene is saved or loaded: the current scene becomes the
// clean baseline.
function markSaved(filePath) {
  if (filePath) currentFilePath = filePath
  lastSavedSignature = sceneSignature()
  isDirty = false
  updateTitle()
}

// Poll for edits so the asterisk stays live without hooking every mutation.
setInterval(() => {
  if (isLoading) return
  const dirty = sceneSignature() !== lastSavedSignature
  if (dirty !== isDirty) {
    isDirty = dirty
    updateTitle()
  }
}, 400)

ipcRenderer.on('scene-saved', (e, filePath) => markSaved(filePath))
// ---------------------------------------------------------------------------

function closeEditVideo() {
  //state.editVideo.videoElement.removeEventListener('timeupdate', onPlayerProgress)
  state.mode = 'standard'
  updateScaleAndTranslate(state.editVideo.backupState.currentScale, state.editVideo.backupState.translate)
  state.editVideo.video.element.className = state.editVideo.backupState.elementClasses
  document.querySelector('#root').classList.remove('disableBorder')
  document.querySelector('#editVideoTools').classList.add('hide')
  state.editVideo = {}
}

function editVideo(video) {
  console.log('video', video)
  state.mode = 'edit-video'
  document.querySelector('#root').style.cursor = ""
  state.editVideo.video = video
  state.editVideo.backupState = {
    currentScale: state.currentScale,
    translate: Object.assign({}, state.translate),
    elementClasses: video.element.className
  }
  updateScaleAndTranslate(1, {
    translateX: 0,
    translateY: 0
  })

  video.element.className = "editVideo"
  document.querySelector('#root').classList.add('disableBorder')
  document.querySelector('#editVideoTools').classList.remove('hide')

  document.getElementById('eventTrigger').dataset.changesliders = JSON.stringify(video.loopPairs[video.activeLoopPair])

  if (video.type == 'youtube') {
    state.editVideo.videoElement = document.querySelector('.editVideo iframe').contentDocument.querySelector('video')
  } else {
    state.editVideo.videoElement = document.querySelector('.editVideo')
  }

  //state.editVideo.videoElement.addEventListener('timeupdate', onPlayerProgress)
  //

  console.log(video)
}

function onPlayerProgress(e) {
  //am i editvideo?
  //  handle edit stuff
  let sliderPositions = document.querySelectorAll('.noUi-handle')
  let leftSliderPercent = Math.min(sliderPositions[0]['ariaValueText'], sliderPositions[1]['ariaValueText'])
  let rightSliderPercent = Math.max(sliderPositions[0]['ariaValueText'], sliderPositions[1]['ariaValueText'])
  //state.editVideo.video
  let sliderElement = document.querySelector('#slider')
  let currentTimePercent = (this.currentTime / this.duration * 100)

  if (this != state.editVideo.videoElement) {

    let leftPercent = parseFloat(this.dataset.loopLeft)
    let rightPercent = parseFloat(this.dataset.loopRight)
    //console.log('im not edit video',leftPercent, rightPercent)
    if (leftPercent > currentTimePercent) {
      this.currentTime = percentToCurrentTime(leftPercent, this.duration)
      currentTimePercent = (this.currentTime / this.duration * 100)
    }
    if (rightPercent < currentTimePercent) {
      this.currentTime = percentToCurrentTime(leftPercent, this.duration)
      currentTimePercent = (this.currentTime / this.duration * 100)
    }
    return;
  }

  //console.log('im edit video')

  state.editVideo.video.loopPairs[state.editVideo.video.activeLoopPair][0] = leftSliderPercent
  state.editVideo.video.loopPairs[state.editVideo.video.activeLoopPair][1] = rightSliderPercent
  this.dataset.loopLeft = leftSliderPercent
  this.dataset.loopRight = rightSliderPercent

  //console.log(state.editVideo.video.loopPairs, leftSliderPercent, rightSliderPercent)

  if (sliderElement.classList.contains('noUi-state-drag')) {
    dragPercent = parseFloat(sliderElement.querySelector('.noUi-active')['ariaValueNow'])
    this.currentTime = percentToCurrentTime(dragPercent, this.duration)
  } else {
    if (leftSliderPercent > currentTimePercent) {
      this.currentTime = percentToCurrentTime(leftSliderPercent, this.duration)
      currentTimePercent = (this.currentTime / this.duration * 100)
    }
    if (rightSliderPercent < currentTimePercent) {
      //.noUi-state-drag
      if (sliderElement.classList.contains('noUi-state-drag')) {
        this.currentTime = percentToCurrentTime(rightSliderPercent, this.duration)
      } else
        this.currentTime = percentToCurrentTime(leftSliderPercent, this.duration)

      currentTimePercent = (this.currentTime / this.duration * 100)
    }
  }
  let progressBarWidth = sliderElement.getBoundingClientRect().width // 10

  let progressBarTimePosition = progressBarWidth * (currentTimePercent / 100) // 4
  //    transform: translateX(41.4966%);
  document.getElementById('progressbar').style.transform = `translateX(${progressBarTimePosition}px)`
  //sliderElement.style.background = `linear-gradient(90deg, rgba(78,47,102,1) 0%, rgba(91,52,122,1) ${progressBarTimePosition}px, rgba(113,80,136,1) ${progressBarTimePosition}px, rgba(121,76,157,1) 100%)`

}
function percentToCurrentTime(percent, duration) {
  if (percent >= 100) return duration
  if (percent <= 0) return 0
  let ct = (percent * duration) / 100
  console.log("percentToCurrentTime", ct)
  return ct
}

function newScene() {
  document.getElementById('itemHolder').innerHTML = ''
  updateScaleAndTranslate(1, {
    translateX: 0,
    translateY: 0
  });
  initWorkspace()
  refreshWorkspace()

  state.elements = []
  document.querySelector('#welcome').classList.remove("hide")

  currentFilePath = null
  lastSavedSignature = sceneSignature() // empty scene is the clean baseline
  isDirty = false
  updateTitle()
}

function loadState(loadedState, filePath) {
  // file stuff

  if (state.mode == 'init')
    init();

  isLoading = true // suppress dirty detection while elements are being populated
  newScene()
  currentFilePath = filePath
  updateTitle()
  updateScaleAndTranslate(loadedState.currentScale, loadedState.translate)

  setTimeout(function () {
    for (var i in loadedState.elements) {
      addMediaWithPath(loadedState.elements[i].path, loadedState.elements[i].type, loadedState.elements[i])
    }
    markSaved(filePath) // the just-loaded scene is the clean baseline
    isLoading = false
    ipcRenderer.send('loaded-state', filePath)
  }, 1000);
}

document.addEventListener('keydown', evt => {
  mouseObj.keys[evt.key] = true


  // On Mac keyboards the main deletion key reports as 'Backspace', not 'Delete'
  // (which is only the fn+Delete forward-delete). Accept both, but don't hijack
  // it while the user is typing in an editable field.
  const t = evt.target
  const editingText = t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')
  if ((evt.key === 'Delete' || evt.key === 'Backspace') && !editingText) {

    console.log('delete selected')
    deleteSelected()
  } else if (evt.key === 'v' && (evt.ctrlKey || evt.metaKey)) {
    ipcRenderer.send('handle-paste')
    console.log('Ctrl+V was pressed');
  } else if (evt.key === ' ' && evt.ctrlKey) {
    mouseObj.ctrlSpace = true;
    console.log('Ctrl+space was pressed');
  } else if (evt.key === ' ') {
    mouseObj.space = true;
  }
});

document.addEventListener('keyup', evt => {
  mouseObj.keys[evt.key] = false
  console.log('keyup', evt.key);
  if (evt.key === ' ' || evt.key == 'Control') {
    mouseObj.ctrlSpace = false;
    console.log('Ctrl+space was released');
    if (evt.key === ' ') {
      mouseObj.space = false;
    }
  }

})

// Window-resize behavior, toggled from the Window menu and persisted in main.
// 'centered' keeps the centered point centered at the same zoom; 'zoom' scales
// the content along with the window. There was previously no resize handling at
// all, so content stayed pinned to the top-left origin as the window grew.
let resizeMode = 'centered'
ipcRenderer.on('set-resize-mode', (e, mode) => { resizeMode = mode })

let lastResizeW = window.innerWidth
let lastResizeH = window.innerHeight
let resizeTransitionTimer = null
window.addEventListener('resize', () => {
  const newW = window.innerWidth, newH = window.innerHeight
  const oldW = lastResizeW, oldH = lastResizeH
  lastResizeW = newW
  lastResizeH = newH
  if (!oldW || !oldH || (newW === oldW && newH === oldH)) return
  if (document.querySelector('.editVideo')) return // video-edit mode fills the window itself

  // The body has a 0.1s transform transition for smooth pan/zoom, which makes
  // content ease behind the window edge during a live resize. Turn it off while
  // resizing so content tracks the edge, and restore it once resizing settles.
  document.body.style.transition = 'none'
  clearTimeout(resizeTransitionTimer)
  resizeTransitionTimer = setTimeout(() => { document.body.style.transition = '' }, 200)

  const s = parseFloat(document.body.dataset.currentScale) || 1
  const tx = parseFloat(document.body.dataset.translateX) || 0
  const ty = parseFloat(document.body.dataset.translateY) || 0

  if (resizeMode === 'zoom') {
    // Scale content with the window, keeping the old window-center point fixed.
    const r = Math.sqrt((newW / oldW) * (newH / oldH))
    const newTx = (newW / 2) - r * ((oldW / 2) - tx)
    const newTy = (newH / 2) - r * ((oldH / 2) - ty)
    updateScaleAndTranslate(s * r, { translateX: newTx, translateY: newTy })
  } else {
    // Keep the current center point centered; content size unchanged.
    updateScaleAndTranslate(s, { translateX: tx + (newW - oldW) / 2, translateY: ty + (newH - oldH) / 2 })
  }
})

function getSelected() {
  if (document.querySelector('.editVideo')) return { type: 'edit-video' }
  let lastIndex = state.elements.length - 1
  if (!state.elements[lastIndex] || !state.elements[lastIndex].element.classList.contains('selectedItem')) return null

  return state.elements[lastIndex]
}
document.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  console.log(state)
  if (mouseObj.dragging) {
    mouseObj.dragging = false;
    return;
  }


})
let mouseObj = {
  initPos: null,
  initClientPos: null,
  dragging: false,
  ctrlSpace: false,
  space: false,
  keys: new Object(),
  //time dragging & distance dragged
}
document.addEventListener('mousedown', (e) => {
  mouseObj.initPos = { x: e.clientX, y: e.clientY }
  mouseObj.initClientPos = { x: e.screenX, y: e.screenY }
  mouseObj.initTranslate = { x: (parseFloat(document.body.dataset.translateX) || 0), y: (parseFloat(document.body.dataset.translateY) || 0) }
  ipcRenderer.send('record-window-size', window.innerHeight, window.innerHeight)
  mouseObj.dragging = false
})
document.addEventListener('mousemove', (e) => {

  // ctrl + space + mouse drag = zoom 
  if (e.buttons == 1 && mouseObj.keys[' '] && mouseObj.keys['Control']) {
    //console.log(`handleZoom(${e.movementX})`);
    handleZoom(e.movementX, mouseObj.initPos.x, mouseObj.initPos.y)
    e.preventDefault()
  } else if (e.buttons == 1 && mouseObj.space) {
    e.preventDefault()
    handleMove(e.movementX, e.movementY)
  } else if (e.buttons == 4) { // middle mouse drag = move
    e.preventDefault()
    handleMove(e.movementX, e.movementY)
  } else if (e.buttons == 2) {
    e.preventDefault()
    ipcRenderer.send('move-electron-window', e.screenX, e.screenY, mouseObj.initPos)
    mouseObj.dragging = true;

  }

})
function handleMove(dX, dY) {
  currentScale = parseFloat(document.body.dataset.currentScale) || 1


  let translateX = (parseFloat(document.body.dataset.translateX) || 0);
  let translateY = (parseFloat(document.body.dataset.translateY) || 0);//(parseFloat(document.body.dataset.translateY) || 0);
  translateX += dX
  translateY += dY //- mouseObj.initTranslate.y 

  updateScaleAndTranslate(currentScale, { translateX, translateY })
}

function handleZoom(_delta, clientX, clientY) {
  if (document.querySelector('.editVideo')) return;
  currentScale = parseFloat(document.body.dataset.currentScale) || 1
  let delta = _delta / 60

  const nextScale = Math.max(currentScale + delta * (currentScale / 2), 0.01)
  const ratio = 1 - nextScale / currentScale
  let translateX = (parseFloat(document.body.dataset.translateX) || 0);
  let translateY = (parseFloat(document.body.dataset.translateY) || 0);

  translateX += (clientX - translateX) * ratio
  translateY += (clientY - translateY) * ratio

  currentScale = nextScale
  updateScaleAndTranslate(currentScale, { translateX, translateY })
  //zoom(nextScale, e)
}
document.addEventListener('mouseup', (e) => {
  console.log(e.button, mouseObj.dragging)
  if (e.button == 2) {
    if (mouseObj.dragging) {

      distance = Math.sqrt(
        Math.pow(e.screenX - mouseObj.initClientPos.x, 2)
        +
        Math.pow(e.screenY - mouseObj.initClientPos.y, 2));
      console.log(distance)
      if (distance < 4) {

        ipcRenderer.send('show-context-menu', getSelected()?.type || "void")
      }
      mouseObj.dragging = false;

    } else {
      ipcRenderer.send('show-context-menu', getSelected()?.type || "void")
    }
  }
})
ipcRenderer.on('close-edit-video', (event, newState) => {
  closeEditVideo()
})
ipcRenderer.on('edit-video', (event, newState) => {
  editVideo(getSelected())
})
ipcRenderer.on('new-scene', (event) => {
  newScene()
})
ipcRenderer.on('load-scene', (event, newState, filePath) => {
  loadState(newState, filePath)
})
ipcRenderer.on('clipboard', (event, msg) => {
  let payload = JSON.parse(msg);
  console.log(payload)
  // When the clipboard holds nothing we recognise, handlePaste sends an empty
  // payload. Without this guard payload[payload.type] is undefined and we'd add
  // a pathless element that renders as an invisible empty box.
  const value = (payload && payload.type) ? payload[payload.type] : null
  if (!value) {
    console.log('paste ignored: clipboard has nothing usable', payload)
    return
  }
  if (/youtube.com\/.*v=([^\?]*)/.test(value)) {
    addMediaWithPath(value, "youtube")
  } else
    addMediaWithPath(value, payload.type)
})
function getCenterOfWindowScaled() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  const widthScaled = (width / 2) / state.currentScale;
  const heightScaled = (height / 2) / state.currentScale;
  return {
    centerX: (-state.translate.translateX / state.currentScale) + widthScaled,
    centerY: (-state.translate.translateY / state.currentScale) + heightScaled
  };
}
function addMediaWithPath(path, type = 'img', loadedState, extra) {
  // Last line of defence: never create an element with no source. Audio cards are
  // exempt because they carry their sources in a tracks array instead.
  if (!path && type !== 'audio') {
    console.log('addMediaWithPath ignored: no source path for type', type)
    return
  }
  isNewElement = loadedState == null
  // Captured before loadedState is defaulted below. Audio cards hold many tracks:
  // on load they come from the saved element, on drop from the dropped batch.
  let audioTracks = (loadedState && loadedState.tracks) || (extra && extra.tracks) || null
  let audioActive = (loadedState && loadedState.activeTrack) || 0
  let centerWin = getCenterOfWindowScaled();
  loadedState = loadedState || { x: centerWin.centerX, y: centerWin.centerY, width: null, height: null }
  if (state.mode == 'init') init();
  if (!document.querySelector('#welcome').classList.contains("hide"))
    document.querySelector('#welcome').classList.add("hide");
  let itemHolder = document.getElementById('itemHolder')

  let mediaElement = undefined
  if (type == 'img' || type == 'dataURL' || type == 'filePath') {
    mediaElement = document.createElement('img')
    if (isNewElement)
      mediaElement.style.opacity = 0;
    mediaElement.addEventListener('load', function loaded() {
      let { x, y, width, height } = this.getClientRects()[0]
      if (isNewElement) {

        //loadedState.x = centerWin.centerX - width / 2
        //loadedState.y = centerWin.centerY - height / 2
        mediaElement.style.opacity = 1;
        setTransformForElement(mediaElement.dataset.zIndex, -width / 2, -height / 2, width, height)
      }
      resizeWorkspaceToFitObj(loadedState.x, loadedState.y, width, height)

    })
    // For file-backed images (not inline data URLs), show the filename if the
    // source is gone, so a broken reference is identifiable and re-sourceable
    // rather than a blank box.
    if (!String(path).startsWith('data:')) {
      mediaElement.alt = String(path).replace(/^.*[\\/]/, '')
      mediaElement.addEventListener('error', function () {
        mediaElement.classList.add('missingRef')
      })
    }
    mediaElement.src = path;
  } else if (type == 'video') {
    mediaElement = document.createElement('video')
    mediaElement.autoplay = true;
    mediaElement.loop = true;
    mediaElement.muted = true;

    let srcElement = document.createElement('source')
    srcElement.src = path;
    mediaElement.appendChild(srcElement)
  } else if (type == 'audio') {
    // A playlist card: a fixed-size container standing in for non-visual media,
    // following the same approach the youtube branch uses below.
    if (!audioTracks || !audioTracks.length) audioTracks = [makeTrack(path)]
    // Defence in depth: a scene file could be hand-edited or shared with a remote
    // URL in its track list. Drop anything that isn't a local path so audio can
    // never stream from the network. Missing local files are kept (they simply
    // fail to decode) so a moved file doesn't silently vanish from the playlist.
    audioTracks = audioTracks.filter(t => t && typeof t.path === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t.path))
    mediaElement = document.createElement('div')
    mediaElement.classList.add('audioCard')
    mediaElement.style.width = (loadedState.width || 380) + "px";
    mediaElement.style.height = (loadedState.height || 260) + "px";
    if (isNewElement) {
      loadedState.width = 380
      loadedState.height = 260
    }
  } else if (type == 'youtube') {
    //mediaElement = document.createElement('iframe')
    if (/youtube.com\/.*v=([^\?]*)/.test(path)) {

      var code = extractYoutubeId(path)
      if (code == null) return;
      mediaElement = document.createElement('div')
      mediaElement.classList.add('youtubePlayer')
      mediaElement.classList.add('playerNeedsSetup')
      mediaElement.dataset.idcode = code

      mediaElement.style.width = (loadedState.width || 640) + "px";
      mediaElement.style.height = (loadedState.height || 360) + "px";

      //mediaElement.style.background = 'red'
      var iframeDiv = document.createElement('div')
      iframeDiv.classList.add('iframeDiv')
      mediaElement.appendChild(iframeDiv)
      document.getElementById('eventTrigger').dataset.youtubetrigger = Date.now()
      /*
      mediaElement.src = 
      `https://www.youtube.com/embed/${code}?` +//&autoplay=1` +
      `&controls=0&disablekb=1&enablejsapi=1&fs=0&loop=1` +
      `&origin=${window.location.href}`
      mediaElement.frameBorder = "0"
      mediaElement.allowFullscreen = false;
      */
    }
  } else if (type == "text") {
    mediaElement = document.createElement('div')
    mediaElement.classList.add('textElement')
    mediaElement.innerText = path

    console.log("isNewElement", isNewElement)
    if (isNewElement) {
      /*
      mediaElement.style.fontSize = '1ch' // 1ch is the width of the 0 character
      mediaElement.style.opacity = 0
      document.body.appendChild(mediaElement)
      let { x, y, width: widthOnDom, height: heightOnDom } = mediaElement.getClientRects()[0]

      document.body.removeChild(mediaElement)
      const windowWidth = window.innerWidth

      const fontScaleFactor = windowWidth / widthOnDom
      newWidth = windowWidth / state.currentScale
      newHeight = (heightOnDom * (windowWidth / widthOnDom)) / state.currentScale

      mediaElement.style.opacity = 1
      mediaElement.style.fontSize = fontScaleFactor + "ch"
      mediaElement.style.width = newWidth + "px";
      mediaElement.style.height = newHeight + "px";
      */
      
      const { width: newWidth, height: newHeight } = adjustFontSize2(mediaElement, path)
      loadedState.x = centerWin.centerX - (newWidth / state.currentScale / 2)
      loadedState.y = centerWin.centerY - (newHeight / state.currentScale / 2)

      loadedState.width = newWidth
      loadedState.height = newHeight
    } else {
      //debugger;
      const { width: newWidth, height: newHeight } = adjustFontSize2(mediaElement, path, loadedState.width)
      oldRatio = loadedState.width / loadedState.height
      console.log("oldRatio", oldRatio, "newRatio", newWidth / newHeight)
      mediaElement.style.width = loadedState.width + "px";
      mediaElement.style.height = newHeight + "px";
      loadedState.width = newWidth
      loadedState.height = newHeight
    }
    mediaElement.width = loadedState.width
    mediaElement.height = loadedState.height

  } else {
    alert('unsupported media type')
    return;
  }
  mediaElement.classList.add('draggable')

  zIndex = state.elements.length;
  mediaElement.style.zIndex = zIndex
  mediaElement.dataset.zIndex = zIndex
  mediaElement.dataset.x = loadedState.x
  mediaElement.dataset.y = loadedState.y
  if (loadedState.width != null && loadedState.height != null) {
    mediaElement.width = loadedState.width
    mediaElement.height = loadedState.height
  }
  let mediaObj = {
    path: path,
    type: type,
    element: mediaElement,
    width: loadedState.width,
    height: loadedState.height
  }
  if (type == 'youtube' || type == 'video') {
    mediaObj.loopPairs = loadedState.loopPairs || [[0, 100]] // 0% & 100% positions for loop
    mediaObj.activeLoopPair = loadedState.activeLoopPair || 0
  }
  if (type == 'audio') {
    // Trim lives per track rather than in the card-level loopPairs used by
    // video/youtube, since one card holds many sounds.
    mediaObj.tracks = audioTracks
    mediaObj.activeTrack = Math.min(audioActive, audioTracks.length - 1)
  }

  state.elements.push(mediaObj)
  if (type == 'video') {
    mediaObj.element.dataset.loopLeft = mediaObj.loopPairs[mediaObj.activeLoopPair][0]
    mediaObj.element.dataset.loopRight = mediaObj.loopPairs[mediaObj.activeLoopPair][1]
    mediaObj.element.addEventListener('timeupdate', onPlayerProgress)
  }

  itemHolder.appendChild(mediaElement)
  if (type == 'audio') initAudioCard(mediaObj) // needs to be in the DOM to size the canvas

  //debugger;
  if (type == 'text') {
    //setTransformForElement(zIndex, 0, 0, loadedState.width, loadedState.height)
    console.log("loadedState", loadedState, mediaElement)
    setTransformForElement(zIndex)

    //adjustFontSize2(mediaElement, path, loadedState.width)
  } else
    setTransformForElement(zIndex)
}
function adjustFontSize2(mediaElement, text, maxWidth = window.innerWidth) {
  temp = document.createElement('div')
  temp.style.fontSize = '1ch' // 1ch is the width of the 0 character
  temp.style.position = 'absolute'
  temp.style.opacity = 0
  temp.style.color = "white"
  temp.style.whiteSpace = "nowrap"
  temp.innerText = text
  document.getElementById('hiddenTextTester').appendChild(temp)
  let { x, y, width: widthOnDom, height: heightOnDom } = temp.getClientRects()[0]

  newRatio = widthOnDom / heightOnDom
  console.log("widthOnDom", widthOnDom, "HeightOnDom", heightOnDom, temp.clientWidth, temp.clientHeight, newRatio)
  document.getElementById('hiddenTextTester').removeChild(temp)
  const windowWidth = maxWidth

  const fontScaleFactor = (maxWidth / widthOnDom) //* state.currentScale
  //const fontScaleFactorScaled = fontScaleFactor / state.currentScale
  newWidth = maxWidth
  //newWidthScaled = newWidth / state.currentScale
  newHeight = (heightOnDom * fontScaleFactor)
  //newHeightScaled = newHeight / state.currentScale
  console.log("Adjustfont2", fontScaleFactor, state.currentScale)
  mediaElement.style.opacity = 1
  mediaElement.style.fontSize = fontScaleFactor * state.currentScale + "ch"
  mediaElement.style.width = newWidth + "px";
  mediaElement.style.height = newHeight + "px";

  return { width: newWidth, height: newHeight }
}

// --- Grid snapping ----------------------------------------------------------
// Snapping is applied in canvas coordinates (the same space element x/y live in),
// so the grid stays fixed to the board and scales visually with zoom. It is opt-in
// per call site: setTransformForElement is shared with scene loading, and snapping
// there would shift every element off its saved position on open.
let snapEnabled = false
let gridSize = 25

ipcRenderer.on('set-grid', (e, settings) => {
  if (!settings) return
  snapEnabled = !!settings.enabled
  gridSize = settings.size || 25
  if (gridOverlayVisible) updateGridOverlay()
})

function snapValue(v) {
  return Math.round(v / gridSize) * gridSize
}

let gridOverlayVisible = false

function ensureGridOverlay() {
  let el = document.getElementById('gridOverlay')
  if (!el) {
    el = document.createElement('div')
    el.id = 'gridOverlay'
    // Sibling of <body> so the canvas pan/zoom transform doesn't move it; the
    // lines are positioned from scale/translate instead, keeping them crisp.
    document.documentElement.appendChild(el)
  }
  return el
}

function updateGridOverlay() {
  const el = ensureGridOverlay()
  const scale = parseFloat(document.body.dataset.currentScale) || 1
  const tx = parseFloat(document.body.dataset.translateX) || 0
  const ty = parseFloat(document.body.dataset.translateY) || 0
  const spacing = gridSize * scale
  // Too dense to be readable when zoomed far out — skip rather than draw mush.
  if (spacing < 6) { el.style.display = 'none'; return }
  el.style.backgroundSize = spacing + 'px ' + spacing + 'px'
  el.style.backgroundPosition = (tx % spacing) + 'px ' + (ty % spacing) + 'px'
  el.style.display = 'block'
}

function showGrid() {
  if (!snapEnabled) return
  gridOverlayVisible = true
  updateGridOverlay()
}

function hideGrid() {
  gridOverlayVisible = false
  const el = document.getElementById('gridOverlay')
  if (el) el.style.display = 'none'
}

// --- Image export -----------------------------------------------------------
// Prepares the page for webContents.capturePage(): hides app chrome that isn't
// part of the board, drops selection outlines, and for 'canvas' mode frames all
// content. endExport() puts the view back exactly as it was.
let exportRestore = null

function beginExport(mode) {
  const bar = document.getElementById('macTitlebar')
  exportRestore = {
    barDisplay: bar ? bar.style.display : null,
    currentScale: state.currentScale,
    translate: Object.assign({}, state.translate)
  }
  if (bar) bar.style.display = 'none'
  hideGrid() // never bake the snapping grid into an exported image
  clearAllSelected()

  if (mode === 'canvas' && state.elements.length) {
    // Derive bounds from the elements themselves. state.workspaceRect only ever
    // grows (resizeWorkspaceToFitObj uses min/max and never shrinks on delete),
    // so it would overstate the content area.
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    for (const el of state.elements) {
      const x = parseFloat(el.x) || 0
      const y = parseFloat(el.y) || 0
      const w = parseFloat(el.width) || parseFloat(el.element && el.element.width) || 0
      const h = parseFloat(el.height) || parseFloat(el.element && el.element.height) || 0
      x1 = Math.min(x1, x); y1 = Math.min(y1, y)
      x2 = Math.max(x2, x + w); y2 = Math.max(y2, y + h)
    }
    if (isFinite(x1) && x2 > x1 && y2 > y1) {
      const pad = 24
      const vw = window.innerWidth, vh = window.innerHeight
      const scale = Math.min((vw - pad * 2) / (x2 - x1), (vh - pad * 2) / (y2 - y1), 2)
      const translateX = (vw - (x2 - x1) * scale) / 2 - x1 * scale
      const translateY = (vh - (y2 - y1) * scale) / 2 - y1 * scale
      // Apply directly rather than via updateScaleAndTranslate: that clamps the
      // view using the stale workspaceRect and bails out above 2x, either of
      // which could crop the export. state is left untouched so endExport can
      // restore it cleanly.
      document.body.style.transform =
        'translate(' + translateX + 'px, ' + translateY + 'px) scale(' + scale + ')'
      document.body.dataset.currentScale = scale
      document.body.dataset.translateX = translateX
      document.body.dataset.translateY = translateY
      document.querySelector(':root').style.setProperty('--scale', scale)
    }
  }
  // Give the compositor a frame to settle before the capture is taken.
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 120)))
}

function endExport() {
  if (!exportRestore) return
  const bar = document.getElementById('macTitlebar')
  if (bar) bar.style.display = exportRestore.barDisplay || ''
  updateScaleAndTranslate(exportRestore.currentScale, exportRestore.translate)
  exportRestore = null
}

// --- Audio playlist cards ---------------------------------------------------
// DOM references live in a WeakMap keyed by the card element rather than on the
// mediaObj, so they never reach JSON.stringify when the scene is serialized.
const audioCardRefs = new WeakMap()
const waveformCache = new Map() // absolute path -> Float32Array of peaks
const PEAK_BUCKETS = 1200
let sharedAudioCtx = null
let playingCardEl = null // only one sound plays at a time (per window)

function getAudioCtx() {
  if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)()
  return sharedAudioCtx
}

function activeTrackOf(mediaObj) {
  return mediaObj.tracks && mediaObj.tracks[mediaObj.activeTrack]
}

function initAudioCard(mediaObj) {
  const card = mediaObj.element
  card.innerHTML = ''

  // A drag handle: the interactive controls fill the whole card, so without a
  // dedicated non-interactive strip there would be nothing left to grab to move
  // the card. This header sits outside .audioInteractive so it stays draggable.
  const header = document.createElement('div')
  header.className = 'audioHeader'
  const grip = document.createElement('span')
  grip.className = 'audioGrip'
  grip.textContent = '⠿ Audio'
  header.appendChild(grip)
  card.appendChild(header)

  // Everything interactive lives under .audioInteractive so interact.js can
  // ignoreFrom it — otherwise dragging a trim handle or a track row would drag
  // the whole card.
  const ui = document.createElement('div')
  ui.className = 'audioInteractive'

  const list = document.createElement('div')
  list.className = 'audioList'

  const waveWrap = document.createElement('div')
  waveWrap.className = 'waveWrap'
  const canvas = document.createElement('canvas')
  canvas.className = 'waveform'
  const handleStart = document.createElement('div')
  handleStart.className = 'trimHandle trimStart'
  const handleEnd = document.createElement('div')
  handleEnd.className = 'trimHandle trimEnd'
  waveWrap.appendChild(canvas)
  waveWrap.appendChild(handleStart)
  waveWrap.appendChild(handleEnd)

  const transport = document.createElement('div')
  transport.className = 'audioTransport'
  const playBtn = document.createElement('button')
  playBtn.className = 'audioBtn'
  playBtn.textContent = '▶'
  const loopBtn = document.createElement('button')
  loopBtn.className = 'audioBtn loopBtn'
  loopBtn.textContent = '⟳'
  const label = document.createElement('span')
  label.className = 'audioLabel'
  transport.appendChild(playBtn)
  transport.appendChild(loopBtn)
  transport.appendChild(label)

  const audio = document.createElement('audio') // one per card; src swaps per track
  audio.preload = 'metadata'
  audio.autoplay = false

  ui.appendChild(list)
  ui.appendChild(waveWrap)
  ui.appendChild(transport)
  card.appendChild(ui)
  card.appendChild(audio)

  const refs = { audio, canvas, list, label, playBtn, loopBtn, waveWrap, handleStart, handleEnd, loop: true }
  audioCardRefs.set(card, refs)
  loopBtn.classList.add('on')

  playBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(mediaObj) })
  loopBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    refs.loop = !refs.loop
    loopBtn.classList.toggle('on', refs.loop)
  })

  audio.addEventListener('timeupdate', () => onAudioProgress(mediaObj))
  audio.addEventListener('ended', () => { if (playingCardEl === card) playingCardEl = null; playBtn.textContent = '▶' })
  audio.addEventListener('loadedmetadata', () => { positionHandles(mediaObj); drawWaveform(mediaObj) })

  attachTrimHandle(mediaObj, handleStart, 'loopStart')
  attachTrimHandle(mediaObj, handleEnd, 'loopEnd')

  // Redraw the waveform when the card is resized.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { positionHandles(mediaObj); drawWaveform(mediaObj) })
    ro.observe(card)
  }

  renderTrackList(mediaObj)
  selectTrack(mediaObj, mediaObj.activeTrack || 0, false) // never autoplay on load
}

function renderTrackList(mediaObj) {
  const refs = audioCardRefs.get(mediaObj.element)
  if (!refs) return
  refs.list.innerHTML = ''
  if (!mediaObj.tracks.length) {
    const empty = document.createElement('div')
    empty.className = 'audioEmpty'
    empty.textContent = 'Drop audio files here'
    refs.list.appendChild(empty)
    return
  }
  mediaObj.tracks.forEach((track, i) => {
    const row = document.createElement('div')
    row.className = 'audioRow' + (i === mediaObj.activeTrack ? ' selected' : '')
    const name = document.createElement('span')
    name.className = 'audioRowName'
    name.textContent = track.name
    name.title = track.path
    const del = document.createElement('span')
    del.className = 'audioRowDelete'
    del.textContent = '×'
    row.appendChild(name)
    row.appendChild(del)
    // Click a track to audition it: selects and plays, stopping anything else.
    row.addEventListener('click', (e) => { e.stopPropagation(); selectTrack(mediaObj, i, true) })
    del.addEventListener('click', (e) => { e.stopPropagation(); removeTrack(mediaObj, i) })
    refs.list.appendChild(row)
  })
}

function selectTrack(mediaObj, index, autoplay) {
  const refs = audioCardRefs.get(mediaObj.element)
  if (!refs || !mediaObj.tracks.length) return
  mediaObj.activeTrack = Math.max(0, Math.min(index, mediaObj.tracks.length - 1))
  const track = activeTrackOf(mediaObj)
  refs.audio.src = track.path
  refs.label.textContent = track.name
  renderTrackList(mediaObj)
  positionHandles(mediaObj)
  drawWaveform(mediaObj)
  if (autoplay) playCard(mediaObj)
}

function removeTrack(mediaObj, index) {
  mediaObj.tracks.splice(index, 1)
  if (!mediaObj.tracks.length) {
    // Leave an empty card rather than removing the element: state.elements order
    // is the z-index, so mid-array removal would break other elements. The empty
    // card doubles as a drop target and can be deleted like any other element.
    stopCard(mediaObj)
    mediaObj.activeTrack = 0
    const refs = audioCardRefs.get(mediaObj.element)
    if (refs) {
      refs.audio.removeAttribute('src')
      refs.label.textContent = ''
    }
    renderTrackList(mediaObj)
    drawWaveform(mediaObj)
    return
  }
  selectTrack(mediaObj, Math.min(mediaObj.activeTrack, mediaObj.tracks.length - 1), false)
}

function appendTracksToCard(mediaObj, paths) {
  const existing = new Set(mediaObj.tracks.map(t => t.path))
  paths.forEach(p => { if (!existing.has(p)) mediaObj.tracks.push(makeTrack(p)) })
  renderTrackList(mediaObj)
}

function playCard(mediaObj) {
  const refs = audioCardRefs.get(mediaObj.element)
  if (!refs) return
  // Exclusive: starting one sound stops whatever else was playing.
  if (playingCardEl && playingCardEl !== mediaObj.element) {
    const other = audioCardRefs.get(playingCardEl)
    if (other) { other.audio.pause(); other.playBtn.textContent = '▶' }
  }
  const track = activeTrackOf(mediaObj)
  if (track && refs.audio.duration) {
    const startS = (track.loopStart / 100) * refs.audio.duration
    if (refs.audio.currentTime < startS) refs.audio.currentTime = startS
  }
  playingCardEl = mediaObj.element
  refs.playBtn.textContent = '❚❚'
  const p = refs.audio.play()
  if (p && p.catch) p.catch(err => console.log('audio play failed', err))
}

function stopCard(mediaObj) {
  const refs = audioCardRefs.get(mediaObj.element)
  if (!refs) return
  refs.audio.pause()
  refs.playBtn.textContent = '▶'
  if (playingCardEl === mediaObj.element) playingCardEl = null
}

function togglePlay(mediaObj) {
  const refs = audioCardRefs.get(mediaObj.element)
  if (!refs) return
  if (refs.audio.paused) playCard(mediaObj)
  else stopCard(mediaObj)
}

// Keep playback inside the track's trim region, mirroring how onPlayerProgress
// constrains video via dataset.loopLeft/loopRight.
function onAudioProgress(mediaObj) {
  const refs = audioCardRefs.get(mediaObj.element)
  const track = activeTrackOf(mediaObj)
  if (!refs || !track || !refs.audio.duration) return
  const dur = refs.audio.duration
  const startS = (track.loopStart / 100) * dur
  const endS = (track.loopEnd / 100) * dur
  if (refs.audio.currentTime < startS - 0.05) refs.audio.currentTime = startS
  if (refs.audio.currentTime >= endS) {
    if (refs.loop) refs.audio.currentTime = startS
    else stopCard(mediaObj)
  }
  drawWaveform(mediaObj)
}

function attachTrimHandle(mediaObj, handle, field) {
  handle.addEventListener('mousedown', (downEvt) => {
    downEvt.preventDefault()
    downEvt.stopPropagation()
    const refs = audioCardRefs.get(mediaObj.element)
    if (!refs) return
    const rect = refs.waveWrap.getBoundingClientRect()
    const onMove = (moveEvt) => {
      const track = activeTrackOf(mediaObj)
      if (!track || rect.width <= 0) return
      let pct = ((moveEvt.clientX - rect.left) / rect.width) * 100
      pct = Math.max(0, Math.min(100, pct))
      // Keep the handles ordered with a small minimum region.
      if (field === 'loopStart') track.loopStart = Math.min(pct, track.loopEnd - 1)
      else track.loopEnd = Math.max(pct, track.loopStart + 1)
      positionHandles(mediaObj)
      drawWaveform(mediaObj)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
  })
}

function positionHandles(mediaObj) {
  const refs = audioCardRefs.get(mediaObj.element)
  const track = activeTrackOf(mediaObj)
  if (!refs || !track) return
  refs.handleStart.style.left = track.loopStart + '%'
  refs.handleEnd.style.left = track.loopEnd + '%'
}

// Decode lazily and cache peaks per file, so switching tracks and resizing are
// cheap and a long playlist doesn't decode everything up front.
async function getPeaks(filePath) {
  if (waveformCache.has(filePath)) return waveformCache.get(filePath)
  const buf = await fs.promises.readFile(filePath)
  const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const audioBuf = await getAudioCtx().decodeAudioData(arrayBuf)
  const channel = audioBuf.getChannelData(0)
  const block = Math.max(1, Math.floor(channel.length / PEAK_BUCKETS))
  const peaks = new Float32Array(PEAK_BUCKETS)
  for (let i = 0; i < PEAK_BUCKETS; i++) {
    let max = 0
    const start = i * block
    for (let j = 0; j < block; j++) {
      const v = Math.abs(channel[start + j] || 0)
      if (v > max) max = v
    }
    peaks[i] = max
  }
  waveformCache.set(filePath, peaks)
  return peaks
}

function drawWaveform(mediaObj) {
  const refs = audioCardRefs.get(mediaObj.element)
  if (!refs) return
  const track = activeTrackOf(mediaObj)
  const canvas = refs.canvas
  const w = canvas.clientWidth, h = canvas.clientHeight
  if (w <= 0 || h <= 0) return
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr)
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (!track) return // empty card: nothing to draw

  const peaks = waveformCache.get(track.path)
  if (!peaks) {
    ctx.fillStyle = '#666'
    ctx.font = '11px -apple-system, sans-serif'
    ctx.fillText('decoding…', 6, h / 2)
    getPeaks(track.path)
      .then(() => { if (activeTrackOf(mediaObj) === track) drawWaveform(mediaObj) })
      .catch(err => {
        console.log('waveform decode failed', track.path, err && err.message)
        ctx.clearRect(0, 0, w, h)
        ctx.fillStyle = '#7a4a4a'
        ctx.fillText('could not read audio', 6, h / 2)
      })
    return
  }

  // Dim the trimmed-out regions so the loop region reads clearly.
  const startX = (track.loopStart / 100) * w
  const endX = (track.loopEnd / 100) * w
  ctx.fillStyle = '#1a1a1a'
  ctx.fillRect(0, 0, startX, h)
  ctx.fillRect(endX, 0, w - endX, h)

  const mid = h / 2
  for (let x = 0; x < w; x++) {
    const peak = peaks[Math.floor((x / w) * PEAK_BUCKETS)] || 0
    const amp = peak * (h / 2) * 0.95
    ctx.fillStyle = (x >= startX && x <= endX) ? '#5aa9c9' : '#3c4a50'
    ctx.fillRect(x, mid - amp, 1, Math.max(1, amp * 2))
  }

  if (refs.audio.duration) {
    const px = (refs.audio.currentTime / refs.audio.duration) * w
    ctx.fillStyle = '#e0e0e0'
    ctx.fillRect(px, 0, 1, h)
  }
}

document.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  // Todo check if file is valid

  // Audio files collect into a single playlist card; everything else keeps the
  // existing one-element-per-file behavior.
  const audioPaths = []
  const heicPaths = []
  const otherPaths = []
  for (const f of event.dataTransfer.files) {
    console.log('File Path of dragged files: ', f.path, state)
    // Some drag sources hand over a file with no filesystem path. Skip those
    // rather than adding an element with an undefined source (an empty box).
    if (!f.path || typeof f.path !== 'string') {
      console.log('drop ignored: dragged item has no file path', f && f.name)
      continue
    }
    if (isLocalAudioFile(f.path)) audioPaths.push(f.path)
    else if (isHeicPath(f.path)) heicPaths.push(f.path)
    else otherPaths.push(f.path)
  }

  if (heicPaths.length) {
    // Converting shells out to sips, so do it off the drop handler and add each
    // one as it finishes, keeping the order they were dropped in.
    ;(async () => {
      for (const p of heicPaths) {
        try {
          addMediaWithPath(await convertHeicToDataUrl(p), 'dataURL')
        } catch (e) {
          console.log('could not convert HEIC:', p, e && e.message)
        }
      }
    })()
  }

  for (const p of otherPaths) {
    if (p.endsWith('.mp4')) { addMediaWithPath(p, 'video'); continue }
    // A browser-dragged image lives in a temp file that will be cleaned up, so
    // inline it into the scene. Local images the user owns keep their path.
    if (imageExt(p) && isEphemeralPath(p)) {
      try { addMediaWithPath(inlineImageFile(p), 'dataURL'); continue }
      catch (e) { console.log('could not inline dropped image, keeping path:', p, e && e.message) }
    }
    addMediaWithPath(p)
  }

  if (audioPaths.length) {
    // Dropping onto an existing card appends to its list; otherwise start a new one.
    const cardEl = event.target && event.target.closest ? event.target.closest('.audioCard') : null
    const cardObj = cardEl ? state.elements.find(e => e.element === cardEl) : null
    if (cardObj) appendTracksToCard(cardObj, audioPaths)
    else addMediaWithPath(audioPaths[0], 'audio', null, { tracks: audioPaths.map(makeTrack) })
  }
});
function init() {
  document.documentElement.addEventListener('mousedown', (event) => {
    var target = event.target
    //console.log('click', target)

    if (target.id == 'root' || target.id == 'workspaceBox') {
      console.log('background click')
      clearAllSelected()
    }
  })
  state.mode = 'standard'
}

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
});
function extractYoutubeId(path) {
  const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#\&\?]*).*/;
  var capture = path.match(regExp)//path.match(/v=([^\?]*)/);

  return capture[7]
}

function clampWorkspaceTranslate(ratio, newTranslate) {
  let { translateX, translateY } = newTranslate

  let windowElement = document.getElementById('root')
  let windowWidth = windowElement.clientWidth
  let windowHeight = windowElement.clientHeight

  if (-(translateX) > state.workspaceRect.x2 * ratio) { //workspace off screen to left
    console.log('workspace off screen to left')
    translateX = -(state.workspaceRect.x2 * ratio)
  }
  else if ((translateX) + (state.workspaceRect.x1 * ratio) > windowWidth) { // workspace off screen to right
    console.log('workspace off screen to right')
    translateX = windowWidth - (state.workspaceRect.x1 * ratio)
  }

  if (-(translateY) > state.workspaceRect.y2 * ratio) { // workspace off screen to top
    console.log('workspace off screen to top')
    translateY = -(state.workspaceRect.y2 * ratio)
  }
  else if ((translateY) + (state.workspaceRect.y1 * ratio) > windowHeight) { // workspace off screen to bottom
    console.log('workspace off screen to bottom')
    translateY = windowHeight - (state.workspaceRect.y1 * ratio)
  }
  return { translateX: translateX, translateY: translateY }
}

function updateScaleAndTranslate(newScale, newTranslate) {
  if (newScale > 2) {
    state.currentScale = 2
    return;
  }

  newTranslate = clampWorkspaceTranslate(newScale, newTranslate)
  state.currentScale = newScale
  state.translate = newTranslate
  document.body.style.transform = `translate(${state.translate.translateX}px, ${state.translate.translateY}px) scale(${state.currentScale})`
  document.body.dataset.currentScale = state.currentScale
  document.body.dataset.translateX = state.translate.translateX
  document.body.dataset.translateY = state.translate.translateY
  const ROOTCSS = document.querySelector(':root');
  ROOTCSS.style.setProperty('--scale', newScale);
  if (gridOverlayVisible) updateGridOverlay() // keep grid aligned if the view moves
  //window.currentScale = state.currentScale;
}

let objPlayground = { hi: 'yo' };
contextBridge.exposeInMainWorld('myAPI', {
  updateScaleAndTranslate: updateScaleAndTranslate,
  updateYoutubeOriginalSize: (idcode, w, h) => {
    for (var i in state.elements) {
      if (state.elements[i].type == 'youtube' && extractYoutubeId(state.elements[i].path) == idcode) {

        state.elements[i].width = state.elements[i].width || w;
        state.elements[i].height = state.elements[i].height || h;

        state.elements[i].element.style.width = state.elements[i].width
        state.elements[i].element.style.height = state.elements[i].height

        let videoElement = state.elements[i].element.querySelector('iframe').contentDocument.querySelector('video');
        videoElement.dataset.loopLeft = state.elements[i].loopPairs[state.elements[i].activeLoopPair][0]
        videoElement.dataset.loopRight = state.elements[i].loopPairs[state.elements[i].activeLoopPair][1]
        videoElement.addEventListener('timeupdate', onPlayerProgress)
        console.log(state.elements[i])
      }
    }

  },
  objPlayground: objPlayground,
  // Used by the main process to decide whether to prompt to save on close, and
  // to grab a serializable copy of the scene (same shape as the 'save-scene'
  // handler builds) without a round-trip.
  getElementCount: () => state.elements.length,
  getSceneData: () => {
    var stateCopy = JSON.parse(JSON.stringify(state));
    for (var i = 0; i < stateCopy.elements.length; i++) {
      delete stateCopy.elements[i].element;
    }
    return stateCopy;
  },
  // Current-document info + a fresh dirty check, used by the main process for
  // smart save and the save-on-close prompt.
  getSaveInfo: () => ({ filePath: currentFilePath, name: documentName() }),
  getIsDirty: () => !isLoading && sceneSignature() !== lastSavedSignature,
  beginExport: (mode) => beginExport(mode),
  endExport: () => endExport()

})

interact('.draggable')
  .draggable({
    // The grid is only shown while something is actually being moved.
    listeners: { start: showGrid, move: dragMoveListener, end: hideGrid },
    inertia: false,
    // Audio card controls (track list, waveform, trim handles, buttons) must not
    // drag the card itself.
    ignoreFrom: '.audioInteractive',
  }).on('tap', function (event) {
    var target = event.target

    handleSelected(target)
    //
    event.preventDefault()
  })
function isMouseInBlockingState() {
  if (mouseObj.keys[' '] && mouseObj.keys['Control']) {
    return true
  } else if (mouseObj.keys[' ']) {
    return true
  }
  return false
}
interact('.selectedItem').resizable({
  // resize from all edges and corners
  //allowFrom: '.selectedItem',
  edges: { left: true, right: true, bottom: true, top: true },
  ratio: 1,
  enabled: true,
  margin: 4,
  listeners: [{
    start: showGrid,
    end: hideGrid,
    move(event) {
      if (isMouseInBlockingState()) return;
      var target = event.target
      //handleSelected(target, true)
      console.log('resize')

      if (target.classList.contains('textElement')) {
        adjustFontSize2(target, target.innerText, event.rect.width)
      }
      setTransformForElement(target.dataset.zIndex, event.deltaRect.left, event.deltaRect.top, event.rect.width, event.rect.height, true)
      forceRedraw()
    }
  }],
  modifiers: [
    interact.modifiers.aspectRatio({
      // make sure the width is always double the height
      ratio: 'preserve',
      // also restrict the size by nesting another modifier
    }),
    // minimum size
    interact.modifiers.restrictSize({
      min: { width: 10 }
    })
  ],
  inertia: true
}).draggable({
  listeners: { move: dragMoveListener },
  inertia: false
}).on('tap', function (event) {

  var target = event.target
  handleSelected(target)
  //
  event.preventDefault()
})

function deleteSelected() {
  if (state.elements.length == 0) return

  if (!state.elements[state.elements.length - 1].element.classList.contains('selectedItem')) return

  state.elements[state.elements.length - 1].element.remove();
  //delete state.elements[state.elements.length - 1].element
  state.elements.pop();
  clearAllSelected()
}

function clearAllSelected() {
  document.querySelectorAll('.selectedItem').forEach((elm) => {
    elm.classList.remove('selectedItem')
    elm.classList.add('draggable')
  })
}

function handleSelected(target, dragging = false) {
  if (isMouseInBlockingState()) return;

  clearAllSelected()
  target.classList.remove('draggable')
  target.classList.add('selectedItem')

  if (state.elements.length > 1) {
    let targetIndex = parseInt(target.dataset.zIndex);

    state.elements.push(state.elements.splice(targetIndex, 1)[0]);
    for (var i = targetIndex; i < state.elements.length; i++) { // i can start at targetIndex
      state.elements[i].element.style.zIndex = i;
      state.elements[i].element.dataset.zIndex = i;
    }
  }
}

function dragMoveListener(event) {
  if (isMouseInBlockingState()) return;
  var target = event.target
  handleSelected(target, true)
  setTransformForElement(target.dataset.zIndex, event.dx, event.dy, null, null, true)
  forceRedraw()
}

function resizeWorkspaceToFitObj(x, y, width, height) {
  if (width == 0 || height == 0) return
  state.workspaceRect.x1 = Math.min(x, state.workspaceRect.x1)
  state.workspaceRect.y1 = Math.min(y, state.workspaceRect.y1)

  state.workspaceRect.x2 = Math.max(x + width, state.workspaceRect.x2)
  state.workspaceRect.y2 = Math.max(y + height, state.workspaceRect.y2)
  refreshWorkspace()
}

function initWorkspace() {
  state.workspaceRect = {
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0
  }
}

function refreshWorkspace() {
  const element = document.getElementById('workspaceBox');
  element.style.left = state.workspaceRect.x1 + "px";
  element.style.top = state.workspaceRect.y1 + "px";
  element.style.width = (state.workspaceRect.x2 - state.workspaceRect.x1) + "px"
  element.style.height = (state.workspaceRect.y2 - state.workspaceRect.y1) + "px"

}

// snap is opt-in and passed only from user drag/resize. Scene loading and initial
// placement must never snap, or opening a saved board would move everything.
function setTransformForElement(elementIndex, dx = 0, dy = 0, width = null, height = null, snap = false) {
  let elementObj = state.elements[elementIndex]
  // Accumulate the true, unsnapped position in the dataset. Storing the snapped
  // value here would discard any drag movement smaller than the grid each frame,
  // so only a fast flick (a delta bigger than half a cell) would ever move the
  // element. Snapping is applied only to what gets displayed and saved.
  let rawX = (parseFloat(elementObj.element.dataset.x) || 0) + (dx / state.currentScale)
  let rawY = (parseFloat(elementObj.element.dataset.y) || 0) + (dy / state.currentScale)
  elementObj.element.setAttribute('data-x', rawX)
  elementObj.element.setAttribute('data-y', rawY)

  // Position only: dimensions are left alone so the aspect-ratio lock can't
  // fight the grid and subtly distort images.
  let x = (snap && snapEnabled) ? snapValue(rawX) : rawX
  let y = (snap && snapEnabled) ? snapValue(rawY) : rawY
  elementObj.x = x
  elementObj.y = y

  if (width != null && height != null) {
    elementObj.width = width / state.currentScale
    elementObj.height = height / state.currentScale
    elementObj.element.style.width = width / state.currentScale + 'px'
    elementObj.element.style.height = height / state.currentScale + 'px'
  }

  resizeWorkspaceToFitObj(x, y, elementObj.width || elementObj.element.width, elementObj.height || elementObj.element.height)

  elementObj.element.style.transform = 'translate(' + x + 'px, ' + y + 'px)'
}

function forceRedraw() {
  if (document.body.parentElement.style.backgroundColor == '') {
    document.body.parentElement.style.backgroundColor = '#04040400'
  } else {
    document.body.parentElement.style.backgroundColor = ''
  }
}


window.addEventListener('load', (event) => {
  setTimeout(function () {
    console.log('page is fully loaded');
    ipcRenderer.send('ready')
  }, 2000);

});
