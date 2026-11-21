import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/dark.css'
import App from './App.tsx'
import { AppErrorBoundary } from './AppErrorBoundary.tsx'
import { installNativeContextMenuGuard } from './ui/contextMenuCore'
import { applyTheme, readThemeMode } from './theme/theme'

// WKWebView 默认右键菜单只有 Reload；接管后由各视图提供元素相关操作。
// 输入框保留系统菜单，以便使用原生复制/粘贴。
// 主题必须在首帧前落到 html 上，否则深色模式会先闪一下白屏。
applyTheme(readThemeMode())
installNativeContextMenuGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
