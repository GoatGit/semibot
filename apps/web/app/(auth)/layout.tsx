/**
 * 认证页面布局
 *
 * 用于登录、注册、忘记密码等页面
 * 居中显示的简洁布局
 */

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-base">
      <div className="w-full max-w-md px-6 py-8">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-text-primary">Semibot</h1>
          <p className="text-sm text-text-secondary mt-1">AI Agent 编排平台</p>
        </div>

        {/* 内容区 */}
        {children}
      </div>
    </div>
  )
}
