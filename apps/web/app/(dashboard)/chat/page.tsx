import { redirect } from 'next/navigation'

/**
 * /chat 仅作为入口路由，统一跳转到 /chat/new。
 * 这样左侧“会话”入口和“新建会话”入口保持一致体验。
 */
export default function ChatPage() {
  redirect('/chat/new')
}
