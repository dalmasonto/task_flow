/// Open and close the right-hand detail sheet (see detail-params.ts).
import { useCallback } from "react"
import { useLocation, useNavigate } from "react-router-dom"

import { detailHref, withDetail, type Detail } from "./detail-params"

/// `href(detail)` for a <Link>, `open(detail)` for code, `close()` for the sheet.
export function useDetail() {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const href = useCallback((d: Detail) => detailHref(pathname, search, d), [pathname, search])
  const open = useCallback((d: Detail) => navigate(detailHref(pathname, search, d)), [navigate, pathname, search])
  const close = useCallback(() => navigate(`${pathname}${withDetail(search, null)}`), [navigate, pathname, search])
  return { href, open, close }
}
