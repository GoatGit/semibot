'use client'

import { useEffect } from 'react'

const WEBSITE_HELP_URL = process.env.NEXT_PUBLIC_WEBSITE_URL
  ? `${process.env.NEXT_PUBLIC_WEBSITE_URL}/help`
  : 'http://localhost:3002/help'

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
