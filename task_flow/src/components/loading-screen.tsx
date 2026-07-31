import { useEffect, useState } from 'react'

interface LoadingScreenProps {
  visible: boolean
  onFadeOut: () => void
}

export function LoadingScreen({ visible, onFadeOut }: LoadingScreenProps) {
  const [opacity, setOpacity] = useState(1)

  useEffect(() => {
    if (!visible) {
      setOpacity(0)
      const timer = setTimeout(onFadeOut, 300)
      return () => clearTimeout(timer)
    }
  }, [visible, onFadeOut])

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#f5f5f5] dark:bg-[#0e0e0e]"
      style={{ opacity, transition: 'opacity 0.3s ease-out' }}
    >
      <img src="/favicon.svg" alt="TaskFlow" className="mb-6 h-16 w-16" />
      <div className="mb-6 text-xl font-semibold tracking-tight text-[#1a1a1a] dark:text-[#ececec]">
        TaskFlow
      </div>
      <div className="h-8 w-8 animate-spin rounded-full border-3 border-[rgba(134,59,255,0.2)] border-t-[#863bff]" />
    </div>
  )
}
