import { db } from '../client';
import { type IdentityProfile, identityProfiles } from '../schema/identity';

export type { IdentityProfile } from '../schema/identity';

export async function getIdentityProfiles(): Promise<IdentityProfile[]> {
  return await db.select().from(identityProfiles);
}

export async function setIdentityProfile(
  messageType: string,
  values: { icon: string | null }
): Promise<void> {
  await db
    .insert(identityProfiles)
    .values({
      icon: values.icon,
      messageType,
    })
    .onConflictDoUpdate({
      set: { icon: values.icon },
      target: identityProfiles.messageType,
    });
}
