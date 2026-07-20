const {
  BrowserWindow,
  Menu,
  MenuItem,
  ipcMain,
  app,
  clipboard,
  screen,
  globalShortcut,
  dialog
} = require('electron')
const path = require('path')
const fs = require('fs');
const Store = require('electron-store');

const store = new Store();
//store.clear()

//menu.append(new MenuItem({ label: 'Electron', type: 'checkbox', checked: true }))

let width = 400;
let height = 300;

// Every window is an independent document, so actions must act on the window
// that triggered them. Menu handlers get the invoking window; fall back to the
// focused window, then to any open window.
function targetWindow(win) {
  if (win && !win.isDestroyed()) return win;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  return BrowserWindow.getAllWindows().find(w => !w.isDestroyed()) || null;
}

function sendTo(win, channel, ...args) {
  const w = targetWindow(win);
  if (w) w.webContents.send(channel, ...args);
}

// True if the given bounds overlap any currently connected display, so we don't
// restore a window onto a monitor that has since been unplugged.
function isOnScreen(bounds) {
  return screen.getAllDisplays().some(d => {
    const wa = d.workArea;
    return bounds.x < wa.x + wa.width && bounds.x + bounds.width > wa.x &&
      bounds.y < wa.y + wa.height && bounds.y + bounds.height > wa.y;
  });
}

// Restore the last-used size/position, or on first launch open at a comfortable
// fraction of the primary display instead of the old tiny 400x300 default.
function resolveInitialBounds() {
  let bounds;
  const saved = store.get('windowBounds');
  if (saved && saved.width && saved.height) {
    bounds = (saved.x === undefined || saved.y === undefined || !isOnScreen(saved))
      ? { width: saved.width, height: saved.height }
      : Object.assign({}, saved);
  } else {
    const { workAreaSize } = screen.getPrimaryDisplay();
    bounds = {
      width: Math.min(1400, Math.round(workAreaSize.width * 0.7)),
      height: Math.min(900, Math.round(workAreaSize.height * 0.8)),
    };
  }

  // Cascade additional windows so a new one doesn't land exactly on top of an
  // existing one.
  const open = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).length;
  if (open > 0) {
    let base = bounds;
    if (base.x === undefined || base.y === undefined) {
      const wa = screen.getPrimaryDisplay().workArea;
      base = Object.assign({}, bounds, { x: wa.x + 40, y: wa.y + 40 });
    }
    const cascaded = Object.assign({}, base, { x: base.x + 28 * open, y: base.y + 28 * open });
    return isOnScreen(cascaded) ? cascaded : base;
  }
  return bounds;
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  const bounds = resolveInitialBounds();
  width = bounds.width;
  height = bounds.height;
  const win = new BrowserWindow({
    backgroundColor: "#202020",
    width: bounds.width,
    height: bounds.height,
    minWidth: 400,
    minHeight: 300,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    // On macOS keep the native window controls (close/minimize/maximize
    // "traffic lights") while hiding the rest of the title bar. Other
    // platforms stay fully frameless and move the window via right-drag.
    ...(isMac
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 10, y: 8 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
    }
  })
  win.setAlwaysOnTop(true);

  // Remember size/position so the window reopens the way the user left it.
  // getNormalBounds() ignores maximized/minimized state so we store the real
  // restored size.
  const persistBounds = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const b = win.getNormalBounds();
    width = b.width;
    height = b.height;
    store.set('windowBounds', b);
  };
  win.on('resized', persistBounds);
  win.on('moved', persistBounds);
  win.on('close', persistBounds);

  win.loadFile('index.html')
  return win;
}
app.commandLine.appendSwitch('disable-site-isolation-trials');
const contextMenu = new Menu()
const recentSubmenu = new Menu()
const windowSubmenu = new Menu()
app.whenReady().then(() => {
  // Set when the user chooses to quit (Cmd+Q) so the close handler can quit the
  // app rather than just close the window once any save prompt is resolved.
  let isQuitting = false
  app.on('before-quit', () => { isQuitting = true })

  // Create a window and wire its per-window listeners. Each window is its own
  // independent document — the scene, current file, dirty flag and title all
  // live in that window's renderer. Only the first window at startup restores
  // the most recent scene; windows opened afterwards start blank.
  function createAppWindow(options) {
    const autoLoadRecent = !!(options && options.autoLoadRecent)
    const win = createWindow()
    win.on('ready-to-show', () => {
      console.log('Window ready to be presented');
      win.show();
    });
    win.webContents.on('did-finish-load', () => {
      console.log('Page fully loaded');
      if (autoLoadRecent) loadMostRecent(win)
      win.webContents.send('set-resize-mode', store.get('resizeMode') || 'centered')
    });
    attachSaveOnClose(win)
    return win
  }

  // Prompt to save before closing when the canvas has content. Handles both
  // closing the window (Cmd+W / red traffic light) and quitting (Cmd+Q).
  function attachSaveOnClose(win) {
    win.on('close', async (e) => {
      if (win._animrefAllowClose) return
      e.preventDefault()

      // Prompt only when there are actually unsaved changes (computed fresh, so a
      // change made just before closing isn't missed by the polling interval).
      let dirty = false
      try {
        dirty = await win.webContents.executeJavaScript(
          'window.myAPI && window.myAPI.getIsDirty ? window.myAPI.getIsDirty() : false')
      } catch (err) { dirty = false }

      if (dirty) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Save…', "Don't Save", 'Cancel'],
          defaultId: 0,
          cancelId: 2,
          message: 'Save changes before closing?',
          detail: "If you don't save, your changes will be lost."
        })
        if (response === 2) { isQuitting = false; return }       // Cancel
        if (response === 0 && !(await doSave(win, false))) {     // Save (or Save As) cancelled
          isQuitting = false; return
        }
        // response === 1 (Don't Save) falls through and closes.
      }

      win._animrefAllowClose = true
      if (isQuitting) app.quit()
      else win.close()
    })
  }

  createAppWindow({ autoLoadRecent: true })

  contextMenu.append(new MenuItem({
    id: "close-edit-video", label: 'Close Edit Video', visible: false,
    click: (menuItem, browserWindow, event) => {
      sendTo(browserWindow, 'close-edit-video')
    }
  }));

  contextMenu.append(new MenuItem({
    id: "edit-video", label: 'Edit Video', visible: false,
    click: (menuItem, browserWindow, event) => {
      sendTo(browserWindow, 'edit-video')
    }
  }));
  contextMenu.append(new MenuItem({
    label: 'Paste',
    accelerator: process.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V',
    click: (menuItem, browserWindow, event) => {
      console.log('click paste')

      handlePaste(browserWindow);
    }
  }));
  contextMenu.append(new MenuItem({ type: 'separator' }))

  contextMenu.append(new MenuItem({
    id: 'always-on-top-ctx',
    label: 'Always on Top', type: 'checkbox', checked: true,
    click: (menuItem, browserWindow, event) => {
      const w = targetWindow(browserWindow)
      if (w) w.setAlwaysOnTop(menuItem.checked);
    }
  }));
  globalShortcut.register('Control+Shift+I', () => {
    const w = targetWindow()
    if (w) w.webContents.openDevTools()
  });
  //globalShortcut.register('CommandOrControl+V', handlePaste)

  function handlePaste(win) {
    console.log('handlePaste')

    let payload = {}
    ///strimg = JSON.stringify(img)
    var formats = clipboard.availableFormats();
    var rawFilePath = clipboard.read('FileNameW');

    if (rawFilePath) {
      var filePath = rawFilePath.replace(new RegExp(String.fromCharCode(0), 'g'), '');
      payload.type = 'filePath'
      payload.filePath = filePath
      console.log(filePath)

    } else if (formats.indexOf('image/png') > -1) {
      img = clipboard.readImage();
      payload.type = 'dataURL'
      payload.dataURL = img.toDataURL().replace('png', 'gif')
    } else if (formats.indexOf('text/plain') > -1) {
      //potential link
      var potentialUrl = clipboard.readText()
      console.log("potentialUrl", potentialUrl)
      if (validateUrl(potentialUrl)) {
        payload.type = 'filePath'
        payload.filePath = potentialUrl
      } else {
        // paste as text element
        payload.type = 'text'
        payload.text = clipboard.readText()
      }
    }

    console.log(formats)
    //console.log(payload)
    sendTo(win, 'clipboard', JSON.stringify(payload)) // send to the requesting window
  }
  function addToRecent(filePath) {
    var recent = JSON.parse(store.get('recent') || "[]")
    console.log("addToRecent", store.get('recent'), filePath)
    let index = recent.indexOf(filePath)
    let exists = index != -1
    if (exists) {
      recent.splice(index, 1)
    }
    recent.push(filePath)
    store.set('recent', JSON.stringify(recent));
    console.log("addedToRecent", store.get('recent'), filePath)
    if (!exists) {
      recentSubmenu.append(new MenuItem({
        label: filePath,
        click: (menuItem, browserWindow, event) => {
          readAndLoadFilePath(menuItem.label, false, browserWindow)
        }
      }))
    }
  }
  function populateRecent() {
    var recent = JSON.parse(store.get('recent') || "[]")
    console.log("populateRecent", store.get('recent'))
    for (recentfile of recent) {
      recentSubmenu.append(new MenuItem({
        label: recentfile,
        click: (menuItem, browserWindow, event) => {
          readAndLoadFilePath(menuItem.label, false, browserWindow)
        }
      }))
    }
  }
  function loadMostRecent(win) {
    var recent = JSON.parse(store.get('recent') || "[]")
    if (recent.length > 0)
      readAndLoadFilePath(recent[recent.length - 1], true, win)
  }

  function removeFromRecent(filePath) {
    var recent = JSON.parse(store.get('recent') || "[]")
    var idx = recent.indexOf(filePath)
    if (idx !== -1) {
      recent.splice(idx, 1)
      store.set('recent', JSON.stringify(recent))
    }
  }

  contextMenu.append(new MenuItem({ type: 'separator' }))

  // isAutoLoad = true when loading the most-recent scene at startup: a missing or
  // unreadable file must never crash the app (files get moved/deleted), so prune
  // it and fall back to the next most-recent instead of throwing.
  // The scene is loaded into `win` — the window that asked for it — so loading in
  // one window never disturbs another.
  function readAndLoadFilePath(filePath, isAutoLoad = false, win) {
    const dest = targetWindow(win)
    fs.readFile(filePath, (err, data) => {
      if (err) {
        console.log('Could not open scene file, removing from recent:', filePath, err.code)
        removeFromRecent(filePath)
        if (isAutoLoad) loadMostRecent(dest)
        return
      }
      let newState
      try {
        newState = JSON.parse(data)
      } catch (e) {
        console.log('Could not parse scene file, removing from recent:', filePath, e.message)
        removeFromRecent(filePath)
        if (isAutoLoad) loadMostRecent(dest)
        return
      }
      if (dest && !dest.isDestroyed())
        dest.webContents.send('load-scene', newState, filePath)
    });
  }

  // Shared by both the right-click context menu and the application menu bar.
  function loadSceneDialog(win) {
    const dest = targetWindow(win)
    dialog.showOpenDialog(dest || undefined, {
      properties: ['openFile'],
      filters: [{ name: 'PurRef Gif Scene', extensions: ['purgif'] }]
    }).then(result => {
      if (!result.canceled) readAndLoadFilePath(result.filePaths[0], false, dest)
    }).catch(err => console.log(err))
  }
  // Smart save. When the document already has a file and forceDialog is false,
  // write straight to it with no dialog; otherwise (new document, or Save As)
  // prompt for a location, defaulting to the current file's name.
  async function doSave(win, forceDialog) {
    win = targetWindow(win)
    if (!win || win.isDestroyed()) return false
    let info = null
    try { info = await win.webContents.executeJavaScript('window.myAPI && window.myAPI.getSaveInfo ? window.myAPI.getSaveInfo() : null') } catch (e) {}
    let targetPath = info && info.filePath
    if (forceDialog || !targetPath) {
      const result = await dialog.showSaveDialog(win, {
        defaultPath: targetPath || 'scene.purgif',
        filters: [{ name: 'PurRef Gif Scene', extensions: ['purgif'] }]
      })
      if (result.canceled || !result.filePath) return false
      targetPath = result.filePath
    }
    try {
      const data = await win.webContents.executeJavaScript('window.myAPI.getSceneData()')
      fs.writeFileSync(targetPath, JSON.stringify(data))
      addToRecent(targetPath)
      win.webContents.send('scene-saved', targetPath) // renderer clears dirty + updates title
      return true
    } catch (err) {
      console.log('save failed', err)
      dialog.showErrorBox('Save failed', String((err && err.message) || err))
      return false
    }
  }

  // Persist the resize mode, tell the renderer, and keep both the app menu bar
  // and the right-click menu checkboxes in sync (the toggle lives in both).
  function applyResizeMode(mode) {
    store.set('resizeMode', mode)
    // Resize mode is a global preference: tell every open window.
    BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send('set-resize-mode', mode) })
    const checked = mode === 'zoom'
    const appMenuRef = Menu.getApplicationMenu()
    const appItem = appMenuRef && appMenuRef.getMenuItemById('toggle-zoom-resize')
    if (appItem) appItem.checked = checked
    const ctxItem = contextMenu.getMenuItemById('toggle-zoom-resize-ctx')
    if (ctxItem) ctxItem.checked = checked
  }

  contextMenu.append(new MenuItem({
    label: "Recent", type: 'submenu',
    submenu: recentSubmenu
  }));
  populateRecent()
  contextMenu.append(new MenuItem({
    label: "Window", type: 'submenu',
    submenu: windowSubmenu
  }));
  windowSubmenu.append(new MenuItem({
    label: "Maximize",
    accelerator: process.platform === 'darwin' ? 'Cmd+F' : 'Ctrl+F',
    ///TODO: add fuctionality maximizing a window
    click: (menuItem, browserWindow, event) => {
      console.log("max window");
      if(!browserWindow.isMaximized())
        browserWindow.maximize();
      else
        browserWindow.unmaximize();
    }
  }));
  windowSubmenu.append(new MenuItem({
    label: "Minimize",
    accelerator: process.platform === 'darwin' ? 'Cmd+M' : 'Ctrl+M',
    ///TODO: add fuctionality for minimizing a window
    click: (menuItem, browserWindow, event) => {
      console.log("max window");
      if(!browserWindow.minimize())
        browserWindow.minimize();
    }
  }));
  windowSubmenu.append(new MenuItem({ type: 'separator' }));
  windowSubmenu.append(new MenuItem({
    id: 'toggle-zoom-resize-ctx',
    label: 'Zoom Content When Resizing',
    type: 'checkbox',
    checked: (store.get('resizeMode') || 'centered') === 'zoom',
    click: (item) => applyResizeMode(item.checked ? 'zoom' : 'centered')
  }));
  contextMenu.append(new MenuItem({
    label: 'Load',
    accelerator: process.platform === 'darwin' ? 'Cmd+L' : 'Ctrl+L',
    click: loadSceneDialog
  }));
  contextMenu.append(new MenuItem({
    label: 'Save',
    accelerator: process.platform === 'darwin' ? 'Cmd+S' : 'Ctrl+S',
    click: (menuItem, browserWindow) => doSave(browserWindow, false)
  }));
  contextMenu.append(new MenuItem({
    label: 'Save As…',
    accelerator: process.platform === 'darwin' ? 'Cmd+Shift+S' : 'Ctrl+Shift+S',
    click: (menuItem, browserWindow) => doSave(browserWindow, true)
  }));
  contextMenu.append(new MenuItem({
    label: 'New Window',
    accelerator: process.platform === 'darwin' ? 'Cmd+Shift+N' : 'Ctrl+Shift+N',
    click: () => createAppWindow()
  }));
  contextMenu.append(new MenuItem({
    label: 'New Scene',
    accelerator: process.platform === 'darwin' ? 'Cmd+N' : 'Ctrl+N',
    click: (menuItem, browserWindow, event) => {
      sendTo(browserWindow, 'new-scene');
    }
  }));
  contextMenu.append(new MenuItem({
    label: 'Close',
    accelerator: process.platform === 'darwin' ? 'Cmd+W' : 'Ctrl+W',
    click: (menuItem, browserWindow, event) => {
      browserWindow.close();
    }
  }));

  // The application menu bar (macOS) / window menu (Win/Linux) needs a nested
  // submenu structure — a flat menu is silently dropped on macOS, which also
  // prevents its accelerators from ever firing. Keep `contextMenu` for the
  // right-click popup and build a separate, properly structured menu here.
  const isMac = process.platform === 'darwin';
  const appMenu = Menu.buildFromTemplate([
    // Explicit app menu instead of role:'appMenu' so the name-bearing items read
    // "AnimRef" — the built-in role derives them from app.getName(), which is the
    // lowercase npm package name.
    ...(isMac ? [{
      label: 'AnimRef',
      submenu: [
        { role: 'about', label: 'About AnimRef' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide AnimRef' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit AnimRef' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createAppWindow() },
        { label: 'New Scene', accelerator: 'CmdOrCtrl+N', click: (item, win) => sendTo(win, 'new-scene') },
        { label: 'Load', accelerator: 'CmdOrCtrl+L', click: loadSceneDialog },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: (item, win) => doSave(win, false) },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: (item, win) => doSave(win, true) },
        { type: 'separator' },
        { label: 'Close', accelerator: 'CmdOrCtrl+W', click: (item, win) => win && win.close() },
        ...(isMac ? [] : [{ role: 'quit' }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        // No accelerator here: Cmd/Ctrl+V is handled in preload.js so paste
        // fires exactly once. The menu item remains clickable.
        { label: 'Paste', click: () => handlePaste() }
      ]
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Maximize', accelerator: 'CmdOrCtrl+F',
          click: (item, win) => { if (win) win.isMaximized() ? win.unmaximize() : win.maximize() }
        },
        { label: 'Minimize', accelerator: 'CmdOrCtrl+M', click: (item, win) => win && win.minimize() },
        { type: 'separator' },
        { label: 'Always on Top', type: 'checkbox', checked: true, click: (item, win) => { const w = targetWindow(win); if (w) w.setAlwaysOnTop(item.checked) } },
        {
          // When checked, resizing the window scales the canvas content with it;
          // when unchecked, content keeps its size and just stays centered.
          id: 'toggle-zoom-resize',
          label: 'Zoom Content When Resizing', type: 'checkbox',
          checked: (store.get('resizeMode') || 'centered') === 'zoom',
          click: (item) => applyResizeMode(item.checked ? 'zoom' : 'centered')
        }
      ]
    }
  ])
  Menu.setApplicationMenu(appMenu)

  if (process.argv.indexOf("debug") > -1) {
    const w = targetWindow()
    if (w) w.webContents.openDevTools()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createAppWindow({ autoLoadRecent: true })
    }
  })

  app.on('browser-window-created', (event, win) => {
    win.webContents.on('context-menu', (e, params) => {
      //menu.popup(win, params.x, params.y)
    })
  })
  ipcMain.on('ready', (event, menuType) => {
    //loadMostRecent()
    windowIsReady = true;
  });
  ipcMain.on('show-context-menu', (event, menuType) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    console.log(menuType)
    // The menu is shared across windows, so sync per-window state before showing.
    const aot = contextMenu.getMenuItemById('always-on-top-ctx')
    if (aot && win && !win.isDestroyed()) aot.checked = win.isAlwaysOnTop()
    contextMenu.getMenuItemById("edit-video").visible = false;
    contextMenu.getMenuItemById("close-edit-video").visible = false;
    if (menuType == 'youtube' || menuType == 'video') {
      contextMenu.getMenuItemById("edit-video").visible = true;
    } else if (menuType == 'edit-video') {
      contextMenu.getMenuItemById("close-edit-video").visible = true;
    }
    contextMenu.popup(win)
  })
  // Reflect the renderer's document state onto the native window: title (shown
  // in the Window menu / Mission Control) and the macOS "edited" dot on the
  // close button + proxy-icon filename.
  ipcMain.on('doc-state', (event, info) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || !info) return
    win.setTitle('AnimRef — ' + (info.name || 'Untitled') + (info.isDirty ? ' *' : ''))
    if (process.platform === 'darwin') {
      win.setDocumentEdited(!!info.isDirty)
      try { win.setRepresentedFilename(info.filePath || '') } catch (e) {}
    }
  })
  let dragState = {
    dragging: false
  }
  ipcMain.on('handle-paste', (event, w, h) => {
    handlePaste()
  })
  ipcMain.on('loaded-state', (event, filePath) => {
    addToRecent(filePath)
  })
  ipcMain.on('record-window-size', (event) => {
    // Use the window that actually sent the event, guarded against a destroyed
    // window, so a stale reference can never crash the main process.
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    width = win.getSize()[0]
    height = win.getSize()[1]
  })
  ipcMain.on('move-electron-window', (event, x, y, initPos) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    // Use this window's own size rather than shared globals, so dragging one
    // window can't resize another.
    const b = win.getBounds()
    win.setBounds({
      width: b.width,
      height: b.height,
      x: x - initPos.x,
      y: y - initPos.y
    });
  })
  let loopToLoad = function loopToLoad(){
    if(windowIsReady){
      console.log("loadMostRecent")
      //setTimeout(loadMostRecent, 700)
      //loadMostRecent()
    }
    else{
      console.log("not ready")
      setTimeout(loopToLoad, 100)
    }
  };
  loopToLoad();
})

let windowIsReady = false;
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function validateUrl(value) {
  return /^(?:(?:(?:https?|ftp):)?\/\/)(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u00a1-\uffff0-9]-*)*[a-z\u00a1-\uffff0-9]+)(?:\.(?:[a-z\u00a1-\uffff0-9]-*)*[a-z\u00a1-\uffff0-9]+)*(?:\.(?:[a-z\u00a1-\uffff]{2,})))(?::\d{2,5})?(?:[/?#]\S*)?$/i.test(value);
}