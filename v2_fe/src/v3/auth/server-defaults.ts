/// The build's own server, as the server picker and server accounts page
/// name it. "" means this site's origin.
import { BUILD_API_BASE_URL } from "@/lib/auth-api"

export const DEFAULT_KEY = "__default__"

/// Only the hosted build is "TaskFlow Cloud"; a self-hosted or local build's
/// default is simply this site's own server.
export const DEFAULT_IS_CLOUD = /(^|\.)supercodehive\.com$/.test(new URL(BUILD_API_BASE_URL || window.location.origin).hostname)
export const DEFAULT_NAME = DEFAULT_IS_CLOUD ? "TaskFlow Cloud" : "This site's server"
export const DEFAULT_DETAIL = DEFAULT_IS_CLOUD ? "Hosted by Supercodehive" : `The server ${window.location.host} was built with`
