import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from '@/components/providers/ThemeProvider'
import { ToastContainer } from '@/components/ui/Toast'
import { LocaleProvider } from '@/components/providers/LocaleProvider'

export const metadata: Metadata = {
  title: 'Semibot - 半个通用智能体',
  description: '能干活、能提醒、能协作、能自己变强的大闸蟹。一个本地优先、可安装、可协作、可进化的通用智能体产品。',
  icons: {
    icon: '/semibot-logo.png',
    shortcut: '/semibot-logo.png',
    apple: '/semibot-logo.png',
  },
}

interface RootLayoutProps {
  children: React.ReactNode
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN" data-theme="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body className="min-h-screen bg-bg-base text-text-primary antialiased">
        <ThemeProvider>
          <LocaleProvider>
            {children}
          </LocaleProvider>
          <ToastContainer />
        </ThemeProvider>
      </body>
    </html>
  )
}
