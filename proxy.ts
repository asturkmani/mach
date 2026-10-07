import { authkitProxy } from "@workos-inc/authkit-nextjs";

// Every page and API route requires a signed-in user, except the routes that
// complete or start the WorkOS sign-in flow, and the workflow runtime's own
// routes (agent runs), which it calls itself.
export default authkitProxy({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ["/callback", "/sign-in"],
  },
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.well-known/workflow/).*)"],
};
