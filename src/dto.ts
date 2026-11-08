import { Type, Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, Equals, IsArray, IsBoolean, IsEmail, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, MaxLength } from 'class-validator';
export class RegisterDto {
 @IsEmail() @MaxLength(254) email!:string;
 @IsString() @Length(12,128) password!:string;
 @IsString() @Length(1,80) @Matches(/\S/) displayName!:string;
}
export class LoginDto {
 @IsEmail() @MaxLength(254) email!:string;
 @IsString() @Length(1,128) password!:string;
}
export class RefreshDto { @IsString() @Length(20,512) refreshToken!:string; }
export class TokenDto { @IsString() @Length(20,512) token!:string; }
export class ForgotDto { @IsEmail() @MaxLength(254) email!:string; }
export class ResetDto extends TokenDto { @IsString() @Length(12,128) password!:string; }
export class ProfileDto {
 @IsOptional() @IsString() @Length(1,80) @Matches(/\S/) displayName?:string;
 @IsOptional() @IsString() @MaxLength(2000) bio?:string;
}
export class PageDto {
 @IsOptional() @Type(()=>Number) @IsInt() @Min(1) @Max(50) limit:number=30;
 @IsOptional() @IsString() @MaxLength(4096) cursor?:string;
 @IsOptional() @IsString() @MaxLength(120) q?:string;
 @IsOptional() @IsString() @MaxLength(80) category?:string;
 @IsOptional() @Transform(({value}: {value:unknown})=>value===''?undefined:value) @IsUUID() designerId?:string;
 @IsOptional() @IsString() @Matches(/^(open|resolved)$/) status?:string;
}
export class MetadataDto {
 @IsString() @Length(1,120) @Matches(/\S/) title!:string;
 @IsArray() @ArrayMaxSize(20) @ArrayUnique() @IsString({each:true}) @Length(1,40,{each:true}) @Matches(/\S/,{each:true}) tags!:string[];
}
export class VersionDto { @IsInt() @Min(1) version!:number; }
export class UploadDto {
 @Equals('library') purpose!:string;
 @Matches(/^[a-f0-9]{32}$/i) clientEntryId!:string;
 @IsOptional() @IsUUID() libraryId?:string|null;
 @IsInt() @Min(0) version!:number;
 @IsInt() @Min(68) @Max(100000000) sizeBytes!:number;
 @Matches(/^[a-f0-9]{64}$/) sha256!:string;
 @Equals('application/octet-stream') contentType!:string;
}
export class PublishDto extends MetadataDto {
 @IsString() @MaxLength(4000) description!:string;
 @IsString() @Length(1,80) @Matches(/\S/) category!:string;
 @IsString() @MaxLength(10000000) svg!:string;
 @IsString() @MaxLength(80) licenseVersion!:string;
 @IsBoolean() ownershipConfirmed!:boolean;
 @IsInt() price!:number;
}
export class EditDesignDto extends MetadataDto {
 @IsInt() @Min(1) version!:number;
 @IsString() @MaxLength(4000) description!:string;
 @IsString() @Length(1,80) @Matches(/\S/) category!:string;
}
export class AcquireDto {
 @IsUUID() designId!:string;
 @IsString() @MaxLength(80) licenseVersion!:string;
 @IsBoolean() accepted!:boolean;
}
export class ReportDto { @IsUUID() designId!:string; @IsString() @Length(10,2000) @Matches(/\S/) reason!:string; }
export class ReasonDto { @IsString() @Length(1,2000) @Matches(/\S/) reason!:string; }
export class ResolveDto { @IsString() @Length(1,2000) @Matches(/\S/) resolution!:string; }
