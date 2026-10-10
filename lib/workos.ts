import "server-only";

/**
 * WorkOS's client, loaded when first needed: modules that only sometimes
 * talk to WorkOS (the Chief of Staff's tools, roles) don't load AuthKit, and
 * Next's request APIs with it, wherever they're imported.
 */
export async function workos() {
  const { getWorkOS } = await import("@workos-inc/authkit-nextjs");
  return getWorkOS();
}
