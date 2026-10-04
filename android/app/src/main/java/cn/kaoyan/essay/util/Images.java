package cn.kaoyan.essay.util;

import android.content.ClipData;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;

import cn.kaoyan.essay.EeaProvider;

/**
 * 题图的读取与归一化：相机原图往往带 EXIF 方向、尺寸过大，
 * 统一转正、按最长边压到 MAX_DIMEN，再编码成 data URL 交给 /api/image/analyze。
 */
public final class Images {

    /** 视觉模型看题干足够，再大只是浪费上传时间。 */
    private static final int MAX_DIMEN = 1600;
    private static final int JPEG_QUALITY = 88;
    public static final String CAMERA_NAME = "eea-camera.jpg";

    private Images() {
    }

    /** 相机输出落点：content://cn.kaoyan.essay.eea-files/files/eea-camera.jpg */
    public static Uri cameraUri(Context ctx) {
        return EeaProvider.getUriForFile(new File(ctx.getCacheDir(), CAMERA_NAME));
    }

    /** 图片 → data URL（已按 EXIF 转正、缩放、JPEG 编码）。 */
    public static String toDataUrl(Context ctx, Uri uri) throws IOException {
        Bitmap decoded = decode(ctx, uri);
        Bitmap oriented = applyExif(ctx, uri, decoded);
        try {
            return toDataUrl(oriented);
        } finally {
            oriented.recycle();
        }
    }

    public static String toDataUrl(Bitmap bitmap) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)) {
            throw new IllegalStateException("图片编码失败");
        }
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }

    /** 缩略图（识别结果卡里回显用），失败时返回 null。 */
    public static Bitmap thumbnail(Context ctx, Uri uri, int maxDimen) {
        try {
            return decodeWithMax(ctx, uri, maxDimen);
        } catch (Exception e) {
            return null;
        }
    }

    public static Bitmap decode(Context ctx, Uri uri) throws IOException {
        return decodeWithMax(ctx, uri, MAX_DIMEN);
    }

    /** 剪贴板里的第一个图片 URI（API 33 起读取可能抛权限异常，由调用方兜底）。 */
    public static Uri firstImageUri(ClipData clip) {
        if (clip == null) return null;
        for (int i = 0; i < clip.getItemCount(); i++) {
            Uri uri = clip.getItemAt(i).getUri();
            if (uri != null) return uri;
        }
        return null;
    }

    private static Bitmap decodeWithMax(Context ctx, Uri uri, int maxDimen) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream in = open(ctx, uri)) {
            BitmapFactory.decodeStream(in, null, bounds);
        }
        int longest = Math.max(bounds.outWidth, bounds.outHeight);
        if (longest <= 0) throw new IOException("图片无法读取");
        int sample = 1;
        while (longest / (sample * 2) >= maxDimen) sample *= 2;

        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bitmap;
        try (InputStream in = open(ctx, uri)) {
            bitmap = BitmapFactory.decodeStream(in, null, options);
        }
        if (bitmap == null) throw new IOException("图片无法解码");
        return bitmap;
    }

    private static InputStream open(Context ctx, Uri uri) throws IOException {
        InputStream in = ctx.getContentResolver().openInputStream(uri);
        if (in == null) throw new IOException("无法打开图片");
        return in;
    }

    /** 按 EXIF 方向矩阵转正；没有有效方向时原样返回。 */
    private static Bitmap applyExif(Context ctx, Uri uri, Bitmap bitmap) {
        int orientation = ExifInterface.ORIENTATION_NORMAL;
        try (InputStream in = open(ctx, uri)) {
            orientation = new ExifInterface(in).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (Exception ignored) {
            // 读取失败按未旋转处理
        }
        Matrix matrix = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_ROTATE_90:
                matrix.postRotate(90);
                break;
            case ExifInterface.ORIENTATION_ROTATE_180:
                matrix.postRotate(180);
                break;
            case ExifInterface.ORIENTATION_ROTATE_270:
                matrix.postRotate(270);
                break;
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:
                matrix.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL:
                matrix.postScale(1f, -1f);
                break;
            case ExifInterface.ORIENTATION_TRANSPOSE:
                matrix.postRotate(90);
                matrix.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_TRANSVERSE:
                matrix.postRotate(270);
                matrix.postScale(-1f, 1f);
                break;
            default:
                return bitmap;
        }
        try {
            Bitmap out = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
            if (out != bitmap) bitmap.recycle();
            return out;
        } catch (Exception e) {
            return bitmap;
        }
    }
}
