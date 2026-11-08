/// Profile (design: account-profile): how people and agents see you, and the
/// projects you're in with your role in each.
///
/// Editing (#TSK1134): name, username, and email, which asks for your current
/// password because invitations follow it; a photo (#1135) where the server
/// supports it. A server without the profile route shows the read-only view.
/// Memberships come from the project-scoped REST list of your own member rows.
import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import type { TaskflowProjectMember } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { API_BASE_URL } from "@/lib/auth-api";
import { taskflowApi, taskflowTables } from "@/lib/taskflow-api";

import { ActorAvatar } from "../components/actor-avatar";
import { useLoad } from "../lib/use-load";
import { useWorkspace } from "../workspace";
import { AccountShell } from "./AccountShell";
import {
  ProfileError,
  getProfile,
  patchProfile,
  removeAvatar,
  uploadAvatar,
  type Profile,
} from "./account-api";
import { avatarFileError, profilePatch } from "./account-logic";

async function countOf(
  table: typeof taskflowTables.members | typeof taskflowTables.agents,
  project: number,
): Promise<number> {
  const r = await taskflowApi
    .from(table)
    .filter(
      table === taskflowTables.members
        ? { project, status: "active" }
        : { project },
    )
    .param("page_size", 1)
    .param("fields", "id")
    .list();
  return r.count;
}

/// #1135: the photo, with Upload / Remove. A server without the avatar route
/// sends no `avatar_url` key, and the row keeps the initials-only note.
function AvatarRow({ profile, onSaved }: { profile: Profile; onSaved: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = "avatar_url" in profile;
  const src = profile.avatar_url ? (profile.avatar_url.startsWith("/") ? `${API_BASE_URL}${profile.avatar_url}` : profile.avatar_url) : null;
  const name = profile.full_name || profile.username;

  const pick = async (file: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!file) return;
    const bad = avatarFileError(file);
    if (bad) return setError(bad);
    setError(null);
    setBusy("upload");
    try {
      await uploadAvatar(file);
      toast.success("Photo updated");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't upload the photo.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setError(null);
    setBusy("remove");
    try {
      await removeAvatar();
      toast.success("Photo removed");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove the photo.");
    } finally {
      setBusy(null);
    }
  };

  if (!supported) {
    return (
      <div className="flex items-center gap-4">
        <ActorAvatar name={name} size="xl" />
        <p className="text-xs text-muted-foreground">Your initials show wherever you appear. Photos are on their way.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-4">
      <ActorAvatar name={name} src={src} size="xl" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => input.current?.click()}>
            {busy === "upload" ? <Spinner /> : null}
            {src ? "Change photo" : "Upload photo"}
          </Button>
          {src ? (
            <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void remove()}>
              {busy === "remove" ? <Spinner /> : null}
              Remove
            </Button>
          ) : null}
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" tabIndex={-1} aria-label="Choose a photo" onChange={(e) => void pick(e.target.files?.[0])} />
        </div>
        {error ? (
          <p className="text-xs text-destructive" role="alert">{error}</p>
        ) : (
          <p className="text-xs text-muted-foreground">PNG, JPEG, WebP or GIF, up to 1 MB. Location data is removed, and it&apos;s resized to 512 px.</p>
        )}
      </div>
    </div>
  );
}

function ProfileForm({
  profile,
  onSaved,
}: {
  profile: Profile;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(profile.full_name ?? "");
  const [username, setUsername] = useState(profile.username);
  const [email, setEmail] = useState(profile.email);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<{
    field: string | null;
    message: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const patch = profilePatch(profile, { full_name: fullName, username, email });
  const emailChanged = patch.email != null;
  const dirty = Object.keys(patch).length > 0;

  const discard = () => {
    setFullName(profile.full_name ?? "");
    setUsername(profile.username);
    setEmail(profile.email);
    setPassword("");
    setError(null);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    if (emailChanged && !password)
      return setError({
        field: "current_password",
        message: "Enter your current password to change your email.",
      });
    setPending(true);
    setError(null);
    try {
      await patchProfile({
        ...patch,
        ...(emailChanged ? { current_password: password } : {}),
      });
      setPassword("");
      toast.success(
        "Profile saved",
        emailChanged
          ? { description: "Project invitations now match your new email." }
          : undefined,
      );
      onSaved();
    } catch (err) {
      setError({
        field: err instanceof ProfileError ? err.field : null,
        message:
          err instanceof Error ? err.message : "Couldn't save your profile.",
      });
    } finally {
      setPending(false);
    }
  };

  const fieldError = (f: string) =>
    error?.field === f ? <FieldError>{error.message}</FieldError> : null;

  return (
    <form
      onSubmit={(e) => void save(e)}
      noValidate
      aria-label="Profile"
      className="mt-5 rounded-xl border border-border bg-card p-5"
    >
      <AvatarRow profile={profile} onSaved={onSaved} />
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          className="sm:col-span-2"
          data-invalid={error?.field === "full_name" ? true : undefined}
        >
          <FieldLabel htmlFor="pf-name">Full name</FieldLabel>
          <Input
            id="pf-name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="name"
          />
          {fieldError("full_name")}
        </Field>
        <Field data-invalid={error?.field === "username" ? true : undefined}>
          <FieldLabel htmlFor="pf-user">Username</FieldLabel>
          <Input
            id="pf-user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            spellCheck={false}
          />
          {fieldError("username") ?? (
            <FieldDescription>
              Agents mention you with this. You sign in with it too.
            </FieldDescription>
          )}
        </Field>
        <Field data-invalid={error?.field === "email" ? true : undefined}>
          <FieldLabel htmlFor="pf-email">Email</FieldLabel>
          <Input
            id="pf-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
          {fieldError("email") ?? (
            <FieldDescription>
              Project invitations are matched to this address.
            </FieldDescription>
          )}
        </Field>
        {emailChanged ? (
          <Field
            className="sm:col-span-2"
            data-invalid={
              error?.field === "current_password" ? true : undefined
            }
          >
            <FieldLabel htmlFor="pf-pw">Current password</FieldLabel>
            <Input
              id="pf-pw"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            {fieldError("current_password") ?? (
              <FieldDescription>
                Changing your email needs your password, because invitations
                follow it.
              </FieldDescription>
            )}
          </Field>
        ) : null}
      </div>
      {error && !error.field ? (
        <p className="mt-3 text-sm text-destructive">{error.message}</p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="ghost"
          onClick={discard}
          disabled={!dirty || pending}
        >
          Discard
        </Button>
        <Button type="submit" disabled={!dirty || pending}>
          {pending ? <Spinner /> : null}
          Save profile
        </Button>
      </div>
    </form>
  );
}

export function ProfilePage() {
  const { currentUser, projects, chooseProject, refresh } = useWorkspace();
  const profile = useLoad(
    currentUser ? `profile|${currentUser.id}` : null,
    (signal) => getProfile(signal),
  );
  const mine = useLoad(
    currentUser ? `my-members|${currentUser.id}` : null,
    () =>
      taskflowApi
        .from(taskflowTables.members)
        .filter({ user: currentUser!.id, status: "active" })
        .param("page_size", 100)
        .list()
        .then((r) => r.results as TaskflowProjectMember[]),
  );
  const ids = (mine.data ?? []).map((m) => m.project);
  const sizes = useLoad(
    ids.length ? `sizes|${ids.join(",")}` : null,
    async () =>
      Object.fromEntries(
        await Promise.all(
          ids.map(
            async (p) =>
              [
                p,
                {
                  people: await countOf(taskflowTables.members, p),
                  agents: await countOf(taskflowTables.agents, p),
                },
              ] as const,
          ),
        ),
      ),
  );
  const name = (id: number) =>
    projects.find((p) => p.id === String(id))?.name ?? `Project ${id}`;
  const username = currentUser?.username ?? "";

  return (
    <AccountShell>
      <div>
        <h2 className="font-medium">Profile</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          How people and agents see you in rooms and on tasks.
        </p>
      </div>

      {profile.data ? (
        <ProfileForm
          profile={profile.data}
          onSaved={() => {
            profile.reload();
            refresh();
          }}
        />
      ) : (
        <section className="mt-5 rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-4">
            <ActorAvatar name={username || "You"} size="xl" />
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold">{username}</p>
              <p className="truncate text-sm text-muted-foreground">
                {currentUser?.email}
              </p>
            </div>
          </div>
          {profile.loading ? (
            <Skeleton className="mt-5 h-20" />
          ) : (
            <p className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground">
              This server doesn&apos;t support editing your profile yet.
            </p>
          )}
        </section>
      )}

      <div className="mt-8">
        <h2 className="font-medium">Projects</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Where you&apos;re a member, and your role in each.
        </p>
      </div>
      {mine.loading ? (
        <Skeleton className="mt-5 h-24 rounded-xl" />
      ) : mine.error ? (
        <p className="mt-5 text-sm text-destructive">
          Couldn&apos;t load your projects.
        </p>
      ) : mine.data?.length ? (
        <ul className="mt-5 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {mine.data.map((m) => {
            const s = sizes.data?.[m.project];
            return (
              <li key={m.id}>
                <Link
                  to="/v3/overview"
                  onClick={() => chooseProject(String(m.project))}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
                >
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold uppercase">
                    {name(m.project).slice(0, 2)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {name(m.project)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {s
                        ? `${s.agents} ${s.agents === 1 ? "agent" : "agents"}, ${s.people} ${s.people === 1 ? "person" : "people"}`
                        : " "}
                    </span>
                  </span>
                  <Badge
                    variant={m.role === "owner" ? "secondary" : "outline"}
                    className="capitalize"
                  >
                    {m.role}
                  </Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-5 text-sm text-muted-foreground">
          You&apos;re not in any project yet.{" "}
          <Link to="/v3/projects/new" className="underline underline-offset-4">
            Create one
          </Link>
          .
        </p>
      )}
    </AccountShell>
  );
}
