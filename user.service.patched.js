var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { SALT_ROUNDS } from "../constants.js";
import { StorageCore } from "../cores/storage.core.js";
import { OnEvent, OnJob } from "../decorators.js";
import { mapPreferences } from "../dtos/user-preferences.dto.js";
import { mapUser, mapUserAdmin } from "../dtos/user.dto.js";
import { CacheControl, JobName, JobStatus, QueueName, StorageFolder, UserMetadataKey } from "../enum.js";
import { BaseService } from "./base.service.js";
import { getCalendarHeatmap } from "./shared/user-methods.js";
import { ImmichFileResponse } from "../utils/file.js";
import { mimeTypes } from "../utils/mime-types.js";
import { findOrFail } from "../utils/misc.js";
import { getPreferences, getPreferencesPartial, mergePreferences } from "../utils/preferences.js";
import { generateProfileImage } from "../utils/profile-image.js";
let UserService = class UserService extends BaseService {
    async search(auth) {
    // 1. Fetch the full active user list from the repository
    let users = await this.userRepository.getList({ withDeleted: false });

    // 2. Admins bypass all restrictions
    if (auth.user.isAdmin) {
        return users.map((user) => mapUser(user));
    }

    // 3. Parse explicit environment variables
    const blindEmails = (process.env.BLIND_USER_EMAILS || '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);
        
    const invisibleEmails = (process.env.INVISIBLE_USER_EMAILS || '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);

    // 4. Dynamically parse any variable starting with 'GROUP_'
    const allGroupedEmails = new Set();
    const myGroupedEmails = new Set();
    let isGrouped = false;
    
    const currentUserEmail = (auth.user && auth.user.email) ? auth.user.email.toLowerCase() : '';

    for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('GROUP_') && value) {
            const groupMembers = value.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
            
            // Register these users to the global grouped list
            groupMembers.forEach(email => allGroupedEmails.add(email));
            
            // If the requesting user is in this group, grant them visibility to these members
            if (groupMembers.includes(currentUserEmail)) {
                isGrouped = true;
                groupMembers.forEach(email => myGroupedEmails.add(email));
            }
        }
    }

    const isBlind = blindEmails.includes(currentUserEmail);

    // 5. Apply 'Blind' Rule
    if (isBlind) {
        // Blind users only see themselves
        users = users.filter(u => u.id === auth.user.id);
        return users.map((user) => mapUser(user));
    }

    // 6. Apply 'Group' Rule
    if (isGrouped) {
        // Grouped users only see themselves and members of their groups
        users = users.filter(u => {
            if (u.id === auth.user.id) return true;
            const targetEmail = u.email ? u.email.toLowerCase() : '';
            return myGroupedEmails.has(targetEmail);
        });
        return users.map((user) => mapUser(user));
    }

    // 7. Apply Standard Rule (For non-blind, non-grouped users)
    users = users.filter(u => {
        // A user can always see themselves
        if (u.id === auth.user.id) return true; 
        
        const targetEmail = u.email ? u.email.toLowerCase() : '';
        
        // Hide invisible users
        if (invisibleEmails.includes(targetEmail)) return false;
        
        // Hide all grouped users (keeping groups strictly isolated from the general pool)
        if (allGroupedEmails.has(targetEmail)) return false;

        return true;
    });

    return users.map((user) => mapUser(user));
    }
    async getMe(auth) {
        const user = await this.userRepository.get(auth.user.id, {});
        if (!user) {
            throw new BadRequestException('User not found');
        }
        return mapUserAdmin(user);
    }
    getCalendarHeatmap(auth, dto) {
        return getCalendarHeatmap(auth.user.id, dto, { asset: this.assetRepository });
    }
    async updateMe({ user }, dto) {
        if (dto.email) {
            const duplicate = await this.userRepository.getByEmail(dto.email);
            if (duplicate && duplicate.id !== user.id) {
                this.logger.warn('Email already in use by another account');
                throw new BadRequestException('Email is not available');
            }
        }
        const update = {
            email: dto.email,
            name: dto.name,
            avatarColor: dto.avatarColor,
        };
        if (dto.password) {
            const hashedPassword = await this.cryptoRepository.hashBcrypt(dto.password, SALT_ROUNDS);
            update.password = hashedPassword;
            update.shouldChangePassword = false;
        }
        const updatedUser = await this.userRepository.update(user.id, update);
        return mapUserAdmin(updatedUser);
    }
    async getMyPreferences(auth) {
        const metadata = await this.userRepository.getMetadata(auth.user.id);
        return mapPreferences(getPreferences(metadata));
    }
    async updateMyPreferences(auth, dto) {
        const metadata = await this.userRepository.getMetadata(auth.user.id);
        const updated = mergePreferences(getPreferences(metadata), dto);
        await this.userRepository.upsertMetadata(auth.user.id, {
            key: UserMetadataKey.Preferences,
            value: getPreferencesPartial(updated),
        });
        return mapPreferences(updated);
    }
    async get(id) {
        const user = await this.findOrFail(id, { withDeleted: false });
        return mapUser(user);
    }
    async createProfileImage(auth, file) {
        const { profileImagePath: oldPath } = await this.findOrFail(auth.user.id, { withDeleted: false });
        let profileImagePath;
        try {
            const config = await this.getConfig({ withCache: true });
            profileImagePath = await generateProfileImage({ media: this.mediaRepository, crypto: this.cryptoRepository, storageCore: this.storageCore }, config, auth.user.id, file.path);
        }
        catch (error) {
            await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [file.path] } });
            throw new BadRequestException('Unable to process profile image', { cause: error });
        }
        const user = await this.userRepository.update(auth.user.id, {
            profileImagePath,
            profileChangedAt: new Date(),
        });
        const toDelete = [file.path, ...(oldPath ? [oldPath] : [])];
        await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: toDelete } });
        return {
            userId: user.id,
            profileImagePath: user.profileImagePath,
            profileChangedAt: user.profileChangedAt,
        };
    }
    async deleteProfileImage(auth) {
        const user = await this.findOrFail(auth.user.id, { withDeleted: false });
        if (user.profileImagePath === '') {
            throw new BadRequestException("Can't delete a missing profile Image");
        }
        await this.userRepository.update(auth.user.id, { profileImagePath: '', profileChangedAt: new Date() });
        await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [user.profileImagePath] } });
    }
    async getProfileImage(id) {
        const user = await this.userRepository.get(id, {});
        if (!user || !user.profileImagePath) {
            this.logger.debug('User or profile image not found');
            throw new NotFoundException();
        }
        return new ImmichFileResponse({
            path: user.profileImagePath,
            contentType: mimeTypes.lookup(user.profileImagePath),
            cacheControl: CacheControl.None,
        });
    }
    async getLicense(auth) {
        const metadata = await this.userRepository.getMetadata(auth.user.id);
        const license = metadata.find((item) => item.key === UserMetadataKey.License);
        if (!license) {
            throw new NotFoundException();
        }
        return { ...license.value, activatedAt: new Date(license.value.activatedAt) };
    }
    async deleteLicense({ user }) {
        await this.userRepository.deleteMetadata(user.id, UserMetadataKey.License);
    }
    async setLicense(auth, license) {
        if (!license.licenseKey.startsWith('IMCL-') && !license.licenseKey.startsWith('IMSV-')) {
            throw new BadRequestException('Invalid license key');
        }
        const { licensePublicKey } = this.configRepository.getEnv();
        const isClientLicenseValid = this.cryptoRepository.verifySha256(license.licenseKey, license.activationKey, licensePublicKey.client);
        const isServerLicenseValid = this.cryptoRepository.verifySha256(license.licenseKey, license.activationKey, licensePublicKey.server);
        if (!isClientLicenseValid && !isServerLicenseValid) {
            throw new BadRequestException('Invalid license key');
        }
        const activatedAt = new Date();
        await this.userRepository.upsertMetadata(auth.user.id, {
            key: UserMetadataKey.License,
            value: { ...license, activatedAt: activatedAt.toISOString() },
        });
        return { ...license, activatedAt };
    }
    async getOnboarding(auth) {
        const metadata = await this.userRepository.getMetadata(auth.user.id);
        const onboardingData = metadata.find((item) => item.key === UserMetadataKey.Onboarding)?.value;
        if (!onboardingData) {
            return { isOnboarded: false };
        }
        return {
            isOnboarded: onboardingData.isOnboarded,
        };
    }
    async deleteOnboarding({ user }) {
        await this.userRepository.deleteMetadata(user.id, UserMetadataKey.Onboarding);
    }
    async setOnboarding(auth, onboarding) {
        await this.userRepository.upsertMetadata(auth.user.id, {
            key: UserMetadataKey.Onboarding,
            value: {
                isOnboarded: onboarding.isOnboarded,
            },
        });
        return {
            isOnboarded: onboarding.isOnboarded,
        };
    }
    async onAssetCreate({ asset, file }) {
        if (file) {
            await this.userRepository.updateUsage(asset.ownerId, file.size);
        }
    }
    async handleUserSyncUsage() {
        await this.userRepository.syncUsage();
        return JobStatus.Success;
    }
    async handleUserDeleteCheck() {
        const config = await this.getConfig({ withCache: false });
        const users = await this.userRepository.getDeletedAfter(DateTime.now().minus({ days: config.user.deleteDelay }));
        await this.jobRepository.queueAll(users.map((user) => ({ name: JobName.UserDelete, data: { id: user.id } })));
        return JobStatus.Success;
    }
    async handleUserDelete({ id, force }) {
        const config = await this.getConfig({ withCache: false });
        const user = await this.userRepository.get(id, { withDeleted: true });
        if (!user) {
            return;
        }
        if (!force && !this.isReadyForDeletion(user, config.user.deleteDelay)) {
            this.logger.warn(`Skipped user that was not ready for deletion: id=${id}`);
            return;
        }
        this.logger.log(`Deleting user: ${user.id}`);
        const folders = [
            StorageCore.getLibraryFolder(user),
            StorageCore.getFolderLocation(StorageFolder.Upload, user.id),
            StorageCore.getFolderLocation(StorageFolder.Profile, user.id),
            StorageCore.getFolderLocation(StorageFolder.Thumbnails, user.id),
            StorageCore.getFolderLocation(StorageFolder.EncodedVideo, user.id),
        ];
        for (const folder of folders) {
            this.logger.warn(`Removing user from filesystem: ${folder}`);
            await this.storageRepository.unlinkDir(folder, { recursive: true, force: true });
        }
        this.logger.warn(`Removing user from database: ${user.id}`);
        await this.albumRepository.deleteAll(user.id);
        await this.userRepository.delete(user, true);
        await this.eventRepository.emit('UserDelete', user);
    }
    isReadyForDeletion(user, delayUntilDeletion) {
        if (!user.deletedAt) {
            return false;
        }
        return DateTime.now().minus({ days: delayUntilDeletion }) > DateTime.fromJSDate(user.deletedAt);
    }
    findOrFail(id, options) {
        return findOrFail(() => this.userRepository.get(id, options), 'User');
    }
};
__decorate([
    OnEvent({ name: 'AssetCreate' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], UserService.prototype, "onAssetCreate", null);
__decorate([
    OnJob({ name: JobName.UserSyncUsage, queue: QueueName.BackgroundTask }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], UserService.prototype, "handleUserSyncUsage", null);
__decorate([
    OnJob({ name: JobName.UserDeleteCheck, queue: QueueName.BackgroundTask }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], UserService.prototype, "handleUserDeleteCheck", null);
__decorate([
    OnJob({ name: JobName.UserDelete, queue: QueueName.BackgroundTask }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], UserService.prototype, "handleUserDelete", null);
UserService = __decorate([
    Injectable()
], UserService);
export { UserService };
//# sourceMappingURL=user.service.js.map
