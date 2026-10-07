"use server";

import { getWorkOS, signOut } from "@workos-inc/authkit-nextjs";

import { deleteCompany } from "@/lib/delete-company";
import { requireAppContext } from "@/lib/session";

/**
 * Deletes the company and everything it has in Mach (admins only, after they
 * type its name), then signs them out: their session pointed at it.
 */
export async function deleteCompanyAction(confirmName: string): Promise<{ error?: string }> {
  const { organization, isAdmin } = await requireAppContext();
  if (!isAdmin) return { error: "Only an admin can delete the company." };
  if (confirmName.trim().toLowerCase() !== organization.name.trim().toLowerCase()) {
    return { error: `Type ${organization.name} to confirm.` };
  }
  try {
    await deleteCompany(organization.id, {
      removeFromWorkOS: async (id) => {
        await getWorkOS().organizations.deleteOrganization(id);
      },
    });
  } catch (error) {
    console.error(error);
    return { error: "Couldn't finish deleting the company. Try again: it picks up where it stopped." };
  }
  await signOut();
  return {};
}
