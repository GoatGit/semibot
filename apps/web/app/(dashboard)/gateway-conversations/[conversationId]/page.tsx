import { redirect } from 'next/navigation'

interface LegacyGatewayConversationDetailPageProps {
  params: { conversationId: string }
  searchParams?: Record<string, string | string[] | undefined>
}

export default function LegacyGatewayConversationDetailPage({
  params,
  searchParams,
}: LegacyGatewayConversationDetailPageProps) {
  const conversationId = encodeURIComponent(params.conversationId || '')
  const query = new URLSearchParams()
  const entries = Object.entries(searchParams || {})
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      value.forEach((item) => query.append(key, item))
    } else if (typeof value === 'string') {
      query.set(key, value)
    }
  }
  const suffix = query.toString()
  redirect(`/channel-conversations/${conversationId}${suffix ? `?${suffix}` : ''}`)
}
