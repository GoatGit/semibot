import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from '@/components/providers/ThemeProvider'
import { ToastContainer } from '@/components/ui/Toast'
import { LocaleProvider } from '@/components/providers/LocaleProvider'
import { DynamicMetadata } from '@/components/providers/DynamicMetadata'

export const metadata: Metadata = {
  title: 'Semibot',
  description: 'A local-first, installable, collaborative, and evolvable general-purpose agent.',
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
            <DynamicMetadata />
            {children}
          </LocaleProvider>
          <ToastContainer />
        </ThemeProvider>
      </body>
    </html>
  )
}
