# Immich User Visibility & Groups Hot-Patch

<p align="center"><strong>Tested and working on Immich v3.3.1</strong></p>

A quick, environment variable driven hot patch for [Immich](https://immich.app/) that introduces user groups and strict visibility isolation.

This patch works by using a docker volume bind mount to overlay the `user.service.js` file at runtime. It requires **zero database migrations**, **no custom Docker builds**, and can be controlled entirely via the `.env` file.

**⚠️ Disclaimer:** This is an unofficial workaround. Immich updates frequently, and structural backend changes *might / will* break this patch. See the [Updating Immich](#updating-immich) section before you upgrade your containers.

---

## Features

This patch overrides the global user search/dropdown logic with strict visibility routing:

*   **Admins:** Bypass all restrictions. Admins can always see everyone.
*   **Groups (`GROUP_*`):** Grouped users are placed in isolated bubbles. They can only see themselves and other members of their assigned groups. They cannot see standard users, and standard users cannot see them. Users can belong to multiple groups.
*   **Invisible (`INVISIBLE_USER_EMAILS`):** Hidden from standard users, but still visible to admins and their own group members.
*   **Blind (`BLIND_USER_EMAILS`):** Users who can only see themselves, regardless of group assignments.
*   **Standard Users:** Anyone not listed in the `.env` file. They see everyone *except* grouped or invisible users.

---

## Installation

### 1. Configure your `.env` file

Add the user's emails to your Immich `.env` file. Group variables must start with the prefix `GROUP_`. All emails must be comma-separated.

```env
# Users who can only see themselves
BLIND_USER_EMAILS=guest@example.com

# Users hidden from the global list for standard users
INVISIBLE_USER_EMAILS=ninja@example.com

# Isolated User Groups
GROUP_FAMILY=alice@example.com,bob@example.com,charlie@example.com
GROUP_FRIENDS=alice@example.com,david@example.com
```

---

### 2. Download the Patch File

Download the `user.service.patched.js` file provided in this repository and place it on your server. Keeping it in the same directory as your `docker-compose.yml` is generally the easiest approach.

---

### 3. Mount the Patch

Edit your `docker-compose.yml` to mount the patched file over the original compiled file inside the container. Ensure you map the exact path where your patched file lives on your host to the correct internal container path.

```yaml
services:
  immich-server:
    container_name: immich_server
    # ... existing config ...
    volumes:
      # Bind mount the hot patch over the original file
      - ./user.service.patched.js:/usr/src/app/server/dist/services/user.service.js:ro
```

---

### 4. Apply and Restart

Recreate the container to apply the volume mount and load the new logic:

```bash
docker-compose up -d immich-server
```

You can now freely edit the groups and visibility lists in your `.env` file at any time. Because the environment variables are passed natively, you only need to run `docker-compose restart immich-server` whenever you update the lists to apply the changes.

---

## Updating Immich

Because this patch relies on overlaying a static, transpiled JavaScript file, **you cannot blindly pull Immich updates.** If the developers refactor the backend or change database query signatures, the outdated mounted file will cause the `immich-server` container to crash continuously on startup.

**Safe Update Workflow:**

1. Comment out the patch volume mount in your `docker-compose.yml` (e.g., `# - ./user.service.patched.js...`).
2. Run `docker-compose up -d` to disable the patch and revert to the stock configuration.
3. Pull the new Immich container update and let it start normally.
4. Check this repository for an updated `user.service.patched.js` file that matches your new Immich version. (If one is not yet available, you will need to manually extract the new `user.service.js` from the running container and port the custom logic over).
5. Once you have the version-matched patch file, overwrite your local copy, uncomment the volume mount in your `docker-compose.yml`, and run `docker-compose up -d` again.
