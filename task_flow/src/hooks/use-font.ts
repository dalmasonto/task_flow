import { useEffect } from 'react'
import { useSetting } from '@/hooks/use-settings'
import { FONT_OPTIONS } from '@/lib/constants'

export function useFont() {
  const fontFamily = useSetting('fontFamily')

  useEffect(() => {
    const option = FONT_OPTIONS.find(f => f.value === fontFamily)
    if (option) {
      document.documentElement.style.setProperty('--font-sans', option.css)
    }
  }, [fontFamily])
}
