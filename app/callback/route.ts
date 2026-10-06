import { handleAuth } from "@workos-inc/authkit-nextjs";

// WorkOS redirects here after sign-in (NEXT_PUBLIC_WORKOS_REDIRECT_URI).
export const GET = handleAuth({ returnPathname: "/" });
