package cn.kaoyan.essay;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * 极简文件 ContentProvider（无 androidx 依赖）：
 * 把应用私有目录（cacheDir）里导出的文件以 content:// 暴露给系统分享面板与相机应用。
 * 路由：content://cn.kaoyan.essay.eea-files/files/<文件名>
 *   - eea-camera.jpg   → cacheDir/eea-camera.jpg（拍照输出，相机应用可写）
 *   - 其余             → cacheDir/eea-shared/<文件名>（分享导出，只读）
 */
public class EeaProvider extends ContentProvider {

    public static final String AUTHORITY = "cn.kaoyan.essay.eea-files";
    private static final String CAMERA_NAME = "eea-camera.jpg";

    public static Uri getUriForFile(File file) {
        return Uri.parse("content://" + AUTHORITY + "/files/" + Uri.encode(file.getName()));
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File file = resolve(uri);
        if (file == null) {
            throw new FileNotFoundException("不在允许目录内: " + uri);
        }
        int m = ParcelFileDescriptor.MODE_READ_ONLY;
        if (mode.contains("rw")) {
            m = ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_CREATE;
        } else if (mode.contains("w") || mode.contains("t")) {
            m = ParcelFileDescriptor.MODE_WRITE_ONLY | ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE;
        }
        return ParcelFileDescriptor.open(file, m);
    }

    @Override
    public String getType(Uri uri) {
        File file = resolve(uri);
        if (file == null) return null;
        String ext = file.getName();
        int dot = ext.lastIndexOf('.');
        if (dot >= 0) ext = ext.substring(dot + 1);
        String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return type != null ? type : "application/octet-stream";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file = resolve(uri);
        if (file == null || !file.exists()) return null;
        // 提供 DISPLAY_NAME/SIZE：微信等外部应用据此显示分享文件的真实中文文件名
        MatrixCursor c = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        c.addRow(new Object[]{file.getName(), file.length()});
        return c;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    /** 解析并校验 URI 对应的文件：只允许 cacheDir 内（eea-camera.jpg / eea-shared/*），文件名已由客户端清洗。 */
    private File resolve(Uri uri) {
        if (uri == null || !AUTHORITY.equals(uri.getAuthority())) return null;
        String name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) return null;
        File cache = getContext() != null ? getContext().getCacheDir() : null;
        if (cache == null) return null;
        File file = CAMERA_NAME.equals(name)
                ? new File(cache, CAMERA_NAME)
                : new File(new File(cache, "eea-shared"), name);
        try {
            File cacheRoot = cache.getCanonicalFile();
            File target = file.getCanonicalFile();
            if (!target.getPath().startsWith(cacheRoot.getPath() + File.separator)) return null;
            if (file.exists() && !file.isFile()) return null;
            return file;
        } catch (IOException e) {
            return null;
        }
    }
}
