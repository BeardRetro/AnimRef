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
// Tracks the current live window. Reassigned whenever a window is (re)created so
// IPC handlers and menu actions never reference a destroyed window.
let mainWin;

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
  const saved = store.get('windowBounds');
  if (saved && saved.width && saved.height) {
    if (saved.x === undefined || saved.y === undefined || !isOnScreen(saved)) {
      return { width: saved.width, height: saved.height };
    }
    return saved;
  }
  const { workAreaSize } = screen.getPrimaryDisplay();
  return {
    width: Math.min(1400, Math.round(workAreaSize.width * 0.7)),
    height: Math.min(900, Math.round(workAreaSize.height * 0.8)),
  };
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

  // (Re)create the main window and wire its per-window listeners. Called at
  // startup and again from the 'activate' handler, so `mainWin` always points
  // at a live window even after the window is closed and reopened.
  function openMainWindow() {
    mainWin = createWindow()
    mainWin.on('ready-to-show', () => {
      console.log('Window ready to be presented');
      mainWin.show();
    });
    mainWin.webContents.on('did-finish-load', () => {
      console.log('Page fully loaded');
      //setTimeout(loadMostRecent, 1000)
      loadMostRecent()
    });
    attachSaveOnClose(mainWin)
    return mainWin
  }

  // Prompt to save before closing when the canvas has content. Handles both
  // closing the window (Cmd+W / red traffic light) and quitting (Cmd+Q).
  function attachSaveOnClose(win) {
    win.on('close', async (e) => {
      if (win._animrefAllowClose) return
      e.preventDefault()

      let count = 0
      try {
        count = await win.webContents.executeJavaScript(
          'window.myAPI && window.myAPI.getElementCount ? window.myAPI.getElementCount() : 0')
      } catch (err) { count = 0 }

      if (count > 0) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Save…', "Don't Save", 'Cancel'],
          defaultId: 0,
          cancelId: 2,
          message: 'Save changes before closing?',
          detail: "If you don't save, the current reference scene will be lost."
        })
        if (response === 2) { isQuitting = false; return }       // Cancel
        if (response === 0 && !(await saveForClose(win))) {      // Save cancelled
          isQuitting = false; return
        }
        // response === 1 (Don't Save) falls through and closes.
      }

      win._animrefAllowClose = true
      if (isQuitting) app.quit()
      else win.close()
    })
  }

  // Save flow used by the close prompt; awaits the write so the window isn't torn
  // down before the file is written. Returns false if the user cancels or it fails.
  async function saveForClose(win) {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: 'scene.purgif',
      filters: [{ name: 'PurRef Gif Scene', extensions: ['purgif'] }]
    })
    if (result.canceled || !result.filePath) return false
    try {
      const data = await win.webContents.executeJavaScript('window.myAPI.getSceneData()')
      fs.writeFileSync(result.filePath, JSON.stringify(data))
      addToRecent(result.filePath)
      return true
    } catch (err) {
      console.log('save-on-close failed', err)
      dialog.showErrorBox('Save failed', String((err && err.message) || err))
      return false
    }
  }

  openMainWindow()

  contextMenu.append(new MenuItem({
    id: "close-edit-video", label: 'Close Edit Video', visible: false,
    click: (menuItem, browserWindow, event) => {
      //mainWin.setAlwaysOnTop(menuItem.checked);
      mainWin.webContents.send('close-edit-video')
    }
  }));

  contextMenu.append(new MenuItem({
    id: "edit-video", label: 'Edit Video', visible: false,
    click: (menuItem, browserWindow, event) => {
      //mainWin.setAlwaysOnTop(menuItem.checked);
      mainWin.webContents.send('edit-video')
    }
  }));
  contextMenu.append(new MenuItem({
    label: 'Paste',
    accelerator: process.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V',
    click: (menuItem, browserWindow, event) => {
      console.log('click paste')

      handlePaste();
    }
  }));
  contextMenu.append(new MenuItem({ type: 'separator' }))

  contextMenu.append(new MenuItem({
    label: 'Always on Top', type: 'checkbox', checked: true,
    click: (menuItem, browserWindow, event) => {
      mainWin.setAlwaysOnTop(menuItem.checked);
    }
  }));
  globalShortcut.register('Control+Shift+I', () => {
    mainWin.webContents.openDevTools()
  });
  //globalShortcut.register('CommandOrControl+V', handlePaste)

  function handlePaste() {
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
    mainWin.webContents.send('clipboard', JSON.stringify(payload)) // send to web page
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
          readAndLoadFilePath(menuItem.label)
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
          readAndLoadFilePath(menuItem.label)
        }
      }))
    }
  }
  function loadMostRecent() {
    var recent = JSON.parse(store.get('recent') || "[]")
    if (recent.length > 0)
      readAndLoadFilePath(recent[recent.length - 1])
  }

  contextMenu.append(new MenuItem({ type: 'separator' }))

  function readAndLoadFilePath(filePath) {
    fs.readFile(filePath, (err, data) => {
      if (err) throw err;
      let newState = JSON.parse(data);
      mainWin.webContents.send('load-scene', newState, filePath)
    });
  }

  // Shared by both the right-click context menu and the application menu bar.
  function loadSceneDialog() {
    dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'PurRef Gif Scene', extensions: ['purgif'] }]
    }).then(result => {
      if (!result.canceled) readAndLoadFilePath(result.filePaths[0])
    }).catch(err => console.log(err))
  }
  function saveSceneDialog() {
    dialog.showSaveDialog({
      defaultPath: 'scene.purgif',
      filters: [{ name: 'PurRef Gif Scene', extensions: ['purgif'] }]
    }).then(result => {
      if (!result.canceled) {
        mainWin.webContents.send('save-scene', result.filePath)
        addToRecent(result.filePath)
      }
    }).catch(err => console.log(err))
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
  contextMenu.append(new MenuItem({
    label: 'Load',
    accelerator: process.platform === 'darwin' ? 'Cmd+L' : 'Ctrl+L',
    click: loadSceneDialog
  }));
  contextMenu.append(new MenuItem({
    label: 'Save',
    accelerator: process.platform === 'darwin' ? 'Cmd+S' : 'Ctrl+S',
    click: saveSceneDialog
  }));
  contextMenu.append(new MenuItem({
    label: 'New Scene',
    accelerator: process.platform === 'darwin' ? 'Cmd+N' : 'Ctrl+N',
    click: (menuItem, browserWindow, event) => {
      mainWin.webContents.send('new-scene');
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
        { label: 'New Scene', accelerator: 'CmdOrCtrl+N', click: () => mainWin.webContents.send('new-scene') },
        { label: 'Load', accelerator: 'CmdOrCtrl+L', click: loadSceneDialog },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: saveSceneDialog },
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
        { label: 'Always on Top', type: 'checkbox', checked: true, click: (item) => mainWin.setAlwaysOnTop(item.checked) }
      ]
    }
  ])
  Menu.setApplicationMenu(appMenu)

  if (process.argv.indexOf("debug") > -1)
    mainWin.webContents.openDevTools()
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openMainWindow()
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
    contextMenu.getMenuItemById("edit-video").visible = false;
    contextMenu.getMenuItemById("close-edit-video").visible = false;
    if (menuType == 'youtube' || menuType == 'video') {
      contextMenu.getMenuItemById("edit-video").visible = true;
    } else if (menuType == 'edit-video') {
      contextMenu.getMenuItemById("close-edit-video").visible = true;
    }
    contextMenu.popup(win)
  })
  ipcMain.on('save-scene', (event, filePath, stateCopy) => {
    console.log('save', filePath, stateCopy)
    let data = JSON.stringify(stateCopy);
    fs.writeFileSync(filePath, data);
    //const win = BrowserWindow.fromWebContents(event.sender)
    //menu.popup(win)
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
    win.setBounds({
      width: width,
      height: height,
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