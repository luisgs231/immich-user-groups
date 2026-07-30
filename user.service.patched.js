"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserService = void 0;
const common_1 = require("@nestjs/common");
const luxon_1 = require("luxon");
const constants_1 = require("../constants");
const storage_core_1 = require("../cores/storage.core");
const decorators_1 = require("../decorators");
const user_preferences_dto_1 = require("../dtos/user-preferences.dto");
const user_dto_1 = require("../dtos/user.dto");
const enum_1 = require("../enum");
const base_service_1 = require("./base.service");
const user_methods_1 = require("./shared/user-methods");
const file_1 = require("../utils/file");
const mime_types_1 = require("../utils/mime-types");
const preferences_1 = require("../utils/preferences");
const profile_image_1 = require("../utils/profile-image");
let UserService = class UserService extends base_service_1.BaseService {
    async search(auth) {
    // 1. Fetch the full active user list from the repository
    let users = await this.userRepository.getList({ withDeleted: false });

    // 2. Admins bypass all restrictions
    if (auth.user.isAdmin) {
        return users.map((user) => (0, user_dto_1.mapUser)(user));
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
        return users.map((user) => (0, user_dto_1.mapUser)(user));
    }

    // 6. Apply 'Group' Rule
    if (isGrouped) {
        // Grouped users only see themselves and members of their groups
        users = users.filter(u => {
            if (u.id === auth.user.id) return true;
            const targetEmail = u.email ? u.email.toLowerCase() : '';
            return myGroupedEmails.has(targetEmail);
        });
        return users.map((user) => (0, user_dto_1.mapUser)(user));
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

    return users.map((user) => (0, user_dto_1.mapUser)(user));
    }
    async getMe(auth) {
        const user = await this.userRepository.get(auth.user.id, {});
        if (!user) {
            throw new common_1.BadRequestException('User not found');
        }
        return (0, user_dto_1.mapUserAdmin)(user);
    }
    getCalendarHeatmap(auth, dto) {
        return (0, user_methods_1.getCalendarHeatmap)(auth.user.id, dto, { asset: this.assetRepository });
    }
    async updateMe({ user }, dto) {
        if (dto.email) {
            const duplicate = await this.userRepository.getByEmail(dto.email);
            if (duplicate && duplicate.id !== user.id) {
                this.logger.warn('Email already in use by another account');
                throw new common_1.BadRequestException('Email is not available');
            }
        }
        const update = {
            email: dto.email,
            name: dto.name,
            avatarColor: dto.avatarColor,
        };
        if (dto.password) {
            const hashedPassword = await this.cryptoRepository.hashBcrypt(dto.password, constants_1.SALT_ROUNDS);
            update.password = hashedPassword;
            update.shouldChangePassword = false;
        }
        const updatedUser = await this.userRepository.update(user.id, update);
        return (0, user_dto_1.mapUserAdmin)(updatedUser);
    }
    async getMyPreferences(auth) {
        const metadata = await this.userRepository.getMetadata(auth.user.id);
        return (0, user_preferences_dto_1.mapPreferences)((0, preferences_1.getPreferences)(metadata));
    }
    async updateMyPreferences(auth, dto) {
        const metadata = await this.userRepository.getMetadata(auth.user.id);
        const updated = (0, preferences_1.mergePreferences)((0, preferences_1.getPreferences)(metadata), dto);
        await this.userRepository.upsertMetadata(auth.user.id, {
            key: enum_1.UserMetadataKey.Preferences,
            value: (0, preferences_1.getPreferencesPartial)(updated),
        });
        return (0, user_preferences_dto_1.mapPreferences)(updated);
    }
    async get(id) {
        const user = await this.findOrFail(id, { withDeleted: false });
        return (0, user_dto_1.mapUser)(user);
    }
    async createProfileImage(auth, file) {
        const { profileImagePath: oldPath } = await this.findOrFail(auth.user.id, { withDeleted: false });
        let profileImagePath;
        try {
            const config = await this.getConfig({ withCache: true });
            profileImagePath = await (0, profile_image_1.generateProfileImage)({ media: this.mediaRepository, crypto: this.cryptoRepository, storageCore: this.storageCore }, config, auth.user.id, file.path);
        }
        catch (error) {
            await this.jobRepository.queue({ name: enum_1.JobName.FileDelete, data: { files: [file.path] } });
            throw new common_1.BadRequestException('Unable to process profile image', { cause: error });
        }
        const user = await this.userRepository.update(auth.user.id, {
            profileImagePath,
            profileChangedAt: new Date(),
        });
        const toDelete = [file.path, ...(oldPath ? [oldPath] : [])];
        await this.jobRepository.queue({ name: enum_1.JobName.FileDelete, data: { files: toDelete } });
        return {
            userId: user.id,
            profileImagePath: user.profileImagePath,
            profileChangedAt: user.profileChangedAt,
        };
    }
    async deleteProfileImage(auth) {
        const user = await this.findOrFail(auth.user.id, { withDeleted: false });
        if (user.profileImagePath === '') {
            throw new common_1.BadRequestException("Can't delete a missing profile Image");
        }
        await this.userRepository.update(auth.user.id, { profileImagePath: '', profileChangedAt: new Date() });
        await this.jobRepository.queue({ name: enum_1.JobName.FileDelete, data: { files: [user.profileImagePath] } });
    }
    async getProfileImage(id) {
        const user = await this.userRepository.get(id, {});
        if (!user || !user.profileImagePath) {
            this.logger.debug('User or profile image not found');
            throw new common_1.NotFoundException();
        }
        return new file_1.ImmichFileResponse({
            path: user.profileImagePath,
            contentType: mime_types_1.mimeTypes.lookup(user.profileImagePath),
            cacheControl: enum_1.CacheControl.None,
        });
    }
    async getLicense(auth) {
        const metadata = await this.userRepository.getMetadata(auth.user.id);
        const license = metadata.find((item) => item.key === enum_1.UserMetadataKey.License);
        if (!license) {
            throw new common_1.NotFoundException();
        }
        return { ...license.value, activatedAt: new Date(license.value.activatedAt) };
    }
    async deleteLicense({ user }) {
        await this.userRepository.deleteMetadata(user.id, enum_1.UserMetadataKey.License);
    }
    async setLicense(auth, license) {
        if (!license.licenseKey.startsWith('IMCL-') && !license.licenseKey.startsWith('IMSV-')) {
            throw new common_1.BadRequestException('Invalid license key');
        }
        const { licensePublicKey } = this.configRepository.getEnv();
        const isClientLicenseValid = this.cryptoRepository.verifySha256(license.licenseKey, license.activationKey, licensePublicKey.client);
        const isServerLicenseValid = this.cryptoRepository.verifySha256(license.licenseKey, license.activationKey, licensePublicKey.server);
        if (!isClientLicenseValid && !isServerLicenseValid) {
            throw new common_1.BadRequestException('Invalid license key');
        }
        const activatedAt = new Date();
        await this.userRepository.upsertMetadata(auth.user.id, {
            key: enum_1.UserMetadataKey.License,
            value: { ...license, activatedAt: activatedAt.toISOString() },
        });
        return { ...license, activatedAt };
    }
    async getOnboarding(auth) {
        const metadata = await this.userRepository.getMetadata(auth.user.id);
        const onboardingData = metadata.find((item) => item.key === enum_1.UserMetadataKey.Onboarding)?.value;
        if (!onboardingData) {
            return { isOnboarded: false };
        }
        return {
            isOnboarded: onboardingData.isOnboarded,
        };
    }
    async deleteOnboarding({ user }) {
        await this.userRepository.deleteMetadata(user.id, enum_1.UserMetadataKey.Onboarding);
    }
    async setOnboarding(auth, onboarding) {
        await this.userRepository.upsertMetadata(auth.user.id, {
            key: enum_1.UserMetadataKey.Onboarding,
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
        return enum_1.JobStatus.Success;
    }
    async handleUserDeleteCheck() {
        const config = await this.getConfig({ withCache: false });
        const users = await this.userRepository.getDeletedAfter(luxon_1.DateTime.now().minus({ days: config.user.deleteDelay }));
        await this.jobRepository.queueAll(users.map((user) => ({ name: enum_1.JobName.UserDelete, data: { id: user.id } })));
        return enum_1.JobStatus.Success;
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
            storage_core_1.StorageCore.getLibraryFolder(user),
            storage_core_1.StorageCore.getFolderLocation(enum_1.StorageFolder.Upload, user.id),
            storage_core_1.StorageCore.getFolderLocation(enum_1.StorageFolder.Profile, user.id),
            storage_core_1.StorageCore.getFolderLocation(enum_1.StorageFolder.Thumbnails, user.id),
            storage_core_1.StorageCore.getFolderLocation(enum_1.StorageFolder.EncodedVideo, user.id),
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
        return luxon_1.DateTime.now().minus({ days: delayUntilDeletion }) > luxon_1.DateTime.fromJSDate(user.deletedAt);
    }
    async findOrFail(id, options) {
        const user = await this.userRepository.get(id, options);
        if (!user) {
            throw new common_1.BadRequestException('User not found');
        }
        return user;
    }
};
exports.UserService = UserService;
__decorate([
    (0, decorators_1.OnEvent)({ name: 'AssetCreate' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], UserService.prototype, "onAssetCreate", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.UserSyncUsage, queue: enum_1.QueueName.BackgroundTask }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], UserService.prototype, "handleUserSyncUsage", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.UserDeleteCheck, queue: enum_1.QueueName.BackgroundTask }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], UserService.prototype, "handleUserDeleteCheck", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.UserDelete, queue: enum_1.QueueName.BackgroundTask }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], UserService.prototype, "handleUserDelete", null);
exports.UserService = UserService = __decorate([
    (0, common_1.Injectable)()
], UserService);
//# sourceMappingURL=user.service.js.map
