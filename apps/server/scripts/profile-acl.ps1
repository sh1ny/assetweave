param(
    [Parameter(Mandatory = $true)][ValidateSet('create', 'verify')][string]$Action,
    [Parameter(Mandatory = $true)][string]$ProfilePath
)

$ErrorActionPreference = 'Stop'
$profile = [System.IO.Path]::GetFullPath($ProfilePath)
$root = [System.IO.Path]::GetPathRoot($profile)
if ($root.StartsWith('\\') -or $profile -eq $root) {
    throw 'A local, non-root Windows directory is required for the AssetWeave profile.'
}
$drive = [System.IO.DriveInfo]::new($root)
if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) {
    throw 'The AssetWeave profile must be on a fixed local Windows drive.'
}

# The Windows storage-provider API includes registered legacy and cloud sync
# roots (not just folders named after a specific vendor). Environment paths
# also cover a configured OneDrive folder when it lacks a registration.
try {
    $manager = [Windows.Storage.Provider.StorageProviderSyncRootManager, Windows.Storage.Provider, ContentType=WindowsRuntime]
    $registeredRoots = $manager::GetCurrentSyncRoots()
} catch {
    throw "Cannot query Windows sync roots; refusing an unverified data location: $($_.Exception.Message)"
}
$syncPaths = New-Object 'System.Collections.Generic.List[string]'
foreach ($entry in $registeredRoots) {
    if ($entry.Path -and $entry.Path.Path) { $syncPaths.Add($entry.Path.Path) }
}
foreach ($name in @('OneDrive', 'OneDriveConsumer', 'OneDriveCommercial')) {
    $configured = [System.Environment]::GetEnvironmentVariable($name)
    if ($configured -and [System.IO.Directory]::Exists($configured)) { $syncPaths.Add($configured) }
}
foreach ($syncPath in $syncPaths) {
    $syncRoot = [System.IO.Path]::GetFullPath($syncPath).TrimEnd('\')
    if ($profile.Equals($syncRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $profile.StartsWith($syncRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The AssetWeave profile cannot be inside a live or configured sync root: $syncRoot"
    }
}

$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admins = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$allowed = @($current.Value, $system.Value, $admins.Value)
# Creating a sibling does not grant deletion of an existing protected child.
# DELETE on an existing ancestor or DELETE_CHILD on its parent does; so do
# WRITE_DAC/WRITE_OWNER rights that can grant the attacker those permissions.
$unsafeParentRights = [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership

# Check every existing ancestor before creating or opening the profile. A junction
# above the profile is as dangerous as a junction inside it.
$ancestor = $profile
while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
        $item = Get-Item -LiteralPath $ancestor -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing reparse-point profile path: $ancestor"
        }
        if ($ancestor -ne $profile) {
            $parentAcl = Get-Acl -LiteralPath $ancestor
            foreach ($rule in $parentAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
                if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
                    ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
                if ($allowed -notcontains $rule.IdentityReference.Value -and
                    ($rule.FileSystemRights -band $unsafeParentRights) -ne 0) {
                    throw "An ancestor permits another principal to replace the private profile path: $ancestor"
                }
            }
        }
    }
    $parent = [System.IO.Path]::GetDirectoryName($ancestor.TrimEnd('\'))
    if (-not $parent -or $parent -eq $ancestor) { break }
    $ancestor = $parent
}

if ($Action -eq 'create' -and -not (Test-Path -LiteralPath $profile)) {
    $parentPath = [System.IO.Path]::GetDirectoryName($profile)
    if (-not [System.IO.Directory]::Exists($parentPath)) {
        throw "Create the parent directory securely before creating this profile: $parentPath"
    }
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($current)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @($current, $system, $admins)) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
        $security.AddAccessRule($rule)
    }
    [void][System.IO.Directory]::CreateDirectory($profile, $security)
}
if (-not [System.IO.Directory]::Exists($profile)) {
    throw "The AssetWeave profile directory does not exist: $profile"
}

function Assert-PrivateItem([System.IO.FileSystemInfo]$item, [bool]$isRoot) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing reparse point inside private profile: $($item.FullName)"
    }
    $acl = Get-Acl -LiteralPath $item.FullName
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current.Value) {
        throw "Private profile item is not owned by the current Windows user: $($item.FullName)"
    }
    if ($isRoot -and -not $acl.AreAccessRulesProtected) {
        throw "Private profile inherits access permissions; disable inheritance securely: $($item.FullName)"
    }
    $userHasFullControl = $false
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
        $sid = $rule.IdentityReference.Value
        if ($allowed -notcontains $sid) {
            throw "Private profile grants another principal access: $($item.FullName) ($sid)"
        }
        if ($sid -eq $current.Value -and (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)) {
            $userHasFullControl = $true
        }
    }
    if (-not $userHasFullControl) {
        throw "Current Windows user needs full control of private profile item: $($item.FullName)"
    }
}

$pending = [System.Collections.Generic.Stack[System.IO.FileSystemInfo]]::new()
$pending.Push((Get-Item -LiteralPath $profile -Force))
while ($pending.Count -gt 0) {
    $item = $pending.Pop()
    Assert-PrivateItem $item ($item.FullName -eq $profile)
    if ($item -is [System.IO.DirectoryInfo]) {
        foreach ($child in $item.GetFileSystemInfos()) { $pending.Push($child) }
    }
}
