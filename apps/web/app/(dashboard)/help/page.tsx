'use client'

import { useEffect } from 'react'

const WEBSITE_HELP_URL = 'https://www.semibot.ai/help'

export default function HelpCenterPage() {
  useEffect(() => {
    window.location.href = WEBSITE_HELP_URL
  }, [])

  return (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-text-secondary">Redirecting to help center...</p>
    </div>
  )
}
