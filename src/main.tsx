import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppErrorBoundary } from './AppErrorBoundary.tsx'
import { installNativeContextMenuGuard } from './ui/contextMenuCore'

// WKWebView 默认右键菜单只有 Reload；接管后由各视图提供元素相关操作。
// 输入框保留系统菜单，以便使用原生复制/粘贴。
installNativeContextMenuGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
