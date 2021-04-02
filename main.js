const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow () {
  const win = new BrowserWindow({
    width: 1200,
    height: 1000,
    title: 'Save App',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  //win.setMenuBarVisibility(false)

  win.loadFile('index.html')

  app.on('will-quit', function() {
    win.willQuit();
  });
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})