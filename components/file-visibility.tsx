"use client";

import { setFileVisibilityAction } from "@/app/(app)/files/actions";
import { VisibilityToggle, type Visibility } from "@/components/kit";

/** A library file's Private/Company switch on the Files page. */
export function FileVisibility({ fileId, visibility, canChange }: { fileId: string; visibility: Visibility; canChange: boolean }) {
  return (
    <VisibilityToggle
      visibility={visibility}
      canChange={canChange}
      change={(next) => setFileVisibilityAction(fileId, next)}
      privateMeans="Only its owner and whoever can see the tasks it's on"
    />
  );
}
