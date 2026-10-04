package cn.kaoyan.essay.util;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.util.Base64;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

import cn.kaoyan.essay.EeaProvider;

/**
 * 导出与分享：把 base64（data URL）写成缓存文件后走系统分享面板；
 * http(s) 直链兜底走 DownloadManager。桌面端原有导出能力在移动端的落点。
 */
public final class Exports {

    private Exports() {
    }

    /** 供 WebView 岛屿调用的桥：EEABridge.shareBase64(fileName, base64Data, mime)。 */
    public static void shareBase64(Activity activity, String fileName, String base64Data, String mime) {
        try {
            shareFile(activity, writeSharedFile(activity, fileName, base64Data, mime), mime);
        } catch (Exception e) {
            activity.runOnUiThread(() -> Toast.makeText(activity,
                    "导出失败: " + e.getMessage(), Toast.LENGTH_LONG).show());
        }
    }

    /** 二进制导出（/api/handwrite/pdf 直接返回字节，省去 base64 往返）。 */
    public static void shareBytes(Activity activity, String fileName, byte[] bytes, String mime) {
        try {
            File dir = new File(activity.getCacheDir(), "eea-shared");
            if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建导出目录");
            File f = new File(dir, sanitizeFileName(fileName, mime));
            try (FileOutputStream fos = new FileOutputStream(f)) {
                fos.write(bytes == null ? new byte[0] : bytes);
            }
            shareFile(activity, f, mime);
        } catch (Exception e) {
            activity.runOnUiThread(() -> Toast.makeText(activity,
                    "导出失败: " + e.getMessage(), Toast.LENGTH_LONG).show());
        }
    }

    private static void shareFile(Activity activity, File f, String mime) {
        Uri uri = EeaProvider.getUriForFile(f);
        activity.runOnUiThread(() -> {
            try {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime != null && !mime.isEmpty() ? mime : "application/octet-stream");
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.putExtra(Intent.EXTRA_TITLE, f.getName());
                send.setClipData(ClipData.newRawUri(f.getName(), uri));
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                activity.startActivity(Intent.createChooser(send, "保存/分享"));
            } catch (ActivityNotFoundException e) {
                Toast.makeText(activity, "没有可用的分享/保存方式", Toast.LENGTH_LONG).show();
            }
        });
    }

    /** 直链下载兜底（blob:/data: 走 shareBase64）。 */
    public static void saveDownload(Context ctx, String url, String mime) {
        String fileName = "考研英语作文助手-" + System.currentTimeMillis() + ".pdf";
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            if (mime != null && !mime.isEmpty()) req.setMimeType(mime);
            DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
            dm.enqueue(req);
        } catch (Exception e) {
            // 下载失败不影响主流程
        }
    }

    private static File writeSharedFile(Context ctx, String fileName, String base64Data, String mime)
            throws IOException {
        String safe = sanitizeFileName(fileName, mime);
        File dir = new File(ctx.getCacheDir(), "eea-shared");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建导出目录");
        File f = new File(dir, safe);
        if (f.exists() && !f.delete()) {
            // 忽略：FileOutputStream 打开会截断
        }
        String data = base64Data != null ? base64Data : "";
        int comma = data.indexOf(',');
        if (data.startsWith("data:") && comma >= 0) data = data.substring(comma + 1);
        byte[] bytes = Base64.decode(data, Base64.DEFAULT);
        try (FileOutputStream fos = new FileOutputStream(f)) {
            fos.write(bytes);
        }
        return f;
    }

    private static String sanitizeFileName(String name, String mime) {
        String n = name != null ? name.trim() : "";
        n = n.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").replaceAll("\\s+", " ");
        if (n.isEmpty() || n.equals(".") || n.equals("..")) n = "导出文件";
        if (!n.contains(".")) {
            if (mime != null && mime.contains("pdf")) n += ".pdf";
            else if (mime != null && mime.contains("png")) n += ".png";
            else n += ".bin";
        }
        return n;
    }
}
