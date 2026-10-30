package com.yuedu.reading;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Vibrator;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class MainActivity extends Activity {

    private static final int REQ_AUDIO = 101;
    private static final int REQ_CAMERA = 102;
    private static final int REQ_GALLERY = 103;
    private static final int REQ_GALLERY_MULTI = 104;
    private static final int REQ_FILE = 105;
    private static final int MAX_PICK_IMAGES = 8;
    private static final int MAX_BOOK_BYTES = 12 * 1024 * 1024;
    private static final int SAMPLE_RATE = 16000;

    private WebView web;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private String pendingTts = null;
    private float pendingRate = 1f;
    private boolean pendingZh = false;

    private AudioRecord recorder;
    private Thread recThread;
    private volatile boolean recording = false;
    private ByteArrayOutputStream pcmOut;
    private Uri cameraUri;
    private String lastRecording = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.setStatusBarColor(0xFFF5F7FB);
        w.setNavigationBarColor(0xFFFFFFFF);
        if (Build.VERSION.SDK_INT >= 23) {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
        w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= 21) s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setBackgroundColor(0xFFF5F7FB);
        web.addJavascriptInterface(new Bridge(), "Android");

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override public void run() { request.grant(request.getResources()); }
                });
            }
        });

        try {
            String html = readAsset("index.html");
            web.loadDataWithBaseURL("https://appassets.androidplatform.net/", html, "text/html", "UTF-8", null);
        } catch (Exception e) {
            web.loadUrl("about:blank");
        }

        initTts();
    }

    private String readAsset(String name) throws Exception {
        InputStream in = getAssets().open(name);
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        in.close();
        return new String(bo.toByteArray(), "UTF-8");
    }

    private void initTts() {
        tts = new TextToSpeech(this, new TextToSpeech.OnInitListener() {
            @Override
            public void onInit(int status) {
                if (status == TextToSpeech.SUCCESS) {
                    tts.setLanguage(Locale.US);
                    ttsReady = true;
                    if (pendingTts != null) {
                        speakNow(pendingTts, pendingRate, pendingZh);
                        pendingTts = null;
                    }
                }
            }
        });
    }

    private boolean isZh(String text) {
        return text != null && text.matches(".*[\\u4e00-\\u9fff].*");
    }

    private void speakNow(String text, float rate, boolean zh) {
        if (!ttsReady || tts == null) {
            pendingTts = text;
            pendingRate = rate;
            pendingZh = zh;
            return;
        }
        try {
            tts.setLanguage(zh ? Locale.CHINESE : Locale.US);
        } catch (Exception ignored) {}
        tts.setSpeechRate(Math.max(0.3f, Math.min(1.6f, rate)));
        tts.setPitch(1.03f);
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "yq");
    }

    private void js(final String code) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (web != null) web.evaluateJavascript(code, null);
            }
        });
    }

    /* ------------------------- 录音 ------------------------- */
    private void startRec() {
        try {
            int min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            recorder = new AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, 4096));
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                js("window.Native.onError('麦克风初始化失败')");
                return;
            }
            lastRecording = null;
            pcmOut = new ByteArrayOutputStream();
            recorder.startRecording();
            recording = true;
            recThread = new Thread(new Runnable() {
                @Override public void run() {
                    byte[] buf = new byte[2048];
                    long start = System.currentTimeMillis();
                    long speechStart = 0;
                    long silenceStart = 0;
                    boolean hasSpeech = false;
                    while (recording) {
                        int n = recorder.read(buf, 0, buf.length);
                        if (n > 0) {
                            pcmOut.write(buf, 0, n);
                            // 计算 RMS 做静音检测
                            long sum = 0;
                            for (int i = 0; i + 1 < n; i += 2) {
                                short s = (short) ((buf[i] & 0xff) | (buf[i + 1] << 8));
                                sum += (long) s * s;
                            }
                            double rms = Math.sqrt(sum / (n / 2)) / 32768.0;
                            long now = System.currentTimeMillis();
                            if (rms > 0.012) {
                                if (!hasSpeech) { hasSpeech = true; speechStart = now; }
                                silenceStart = 0;
                            } else if (hasSpeech) {
                                if (silenceStart == 0) silenceStart = now;
                                // 说话开始后，持续静音 1.5s 即自动停止（避免把句中正常停顿误判为结束）
                                if (silenceStart > 0 && now - silenceStart > 1500 && now - speechStart > 800) {
                                    autoStop();
                                    return;
                                }
                            }
                            if (now - start > 15000) { autoStop(); return; } // 最长 15s 兜底
                        } else if (n < 0) {
                            break;
                        }
                    }
                }
            });
            recThread.start();
        } catch (Exception e) {
            js("window.Native.onError('录音启动失败')");
        }
    }

    private void autoStop() {
        if (!recording && lastRecording == null) return;
        recording = false;
        if (recorder != null) {
            try { recorder.stop(); } catch (Exception ignored) {}
            recorder.release();
            recorder = null;
        }
        byte[] pcm = pcmOut == null ? new byte[0] : pcmOut.toByteArray();
        pcmOut = null;
        if (pcm.length >= 3200) lastRecording = Base64.encodeToString(wav(pcm), Base64.NO_WRAP);
        js("window.Native.onAutoStop()");
    }

    private String stopRec() {
        try {
            if (lastRecording != null) {
                String r = lastRecording;
                lastRecording = null;
                return r;
            }
            recording = false;
            if (recThread != null) {
                try { recThread.join(600); } catch (Exception ignored) {}
            }
            if (recorder != null) {
                try { recorder.stop(); } catch (Exception ignored) {}
                recorder.release();
                recorder = null;
            }
            byte[] pcm = pcmOut == null ? new byte[0] : pcmOut.toByteArray();
            if (pcm.length < 3200) return "";
            return Base64.encodeToString(wav(pcm), Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    private void cancelRec() {
        try {
            recording = false;
            if (recThread != null) recThread.join(300);
            if (recorder != null) {
                try { recorder.stop(); } catch (Exception ignored) {}
                recorder.release();
                recorder = null;
            }
            pcmOut = null;
            lastRecording = null;
        } catch (Exception ignored) {}
    }

    private byte[] wav(byte[] pcm) {
        int len = pcm.length;
        byte[] out = new byte[44 + len];
        int byteRate = SAMPLE_RATE * 2;
        out[0] = 'R'; out[1] = 'I'; out[2] = 'F'; out[3] = 'F';
        putInt(out, 4, 36 + len);
        out[8] = 'W'; out[9] = 'A'; out[10] = 'V'; out[11] = 'E';
        out[12] = 'f'; out[13] = 'm'; out[14] = 't'; out[15] = ' ';
        putInt(out, 16, 16);
        putShort(out, 20, 1);
        putShort(out, 22, 1);
        putInt(out, 24, SAMPLE_RATE);
        putInt(out, 28, byteRate);
        putShort(out, 32, 2);
        putShort(out, 34, 16);
        out[36] = 'd'; out[37] = 'a'; out[38] = 't'; out[39] = 'a';
        putInt(out, 40, len);
        System.arraycopy(pcm, 0, out, 44, len);
        return out;
    }

    private void putInt(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xff);
        b[off + 1] = (byte) ((v >> 8) & 0xff);
        b[off + 2] = (byte) ((v >> 16) & 0xff);
        b[off + 3] = (byte) ((v >> 24) & 0xff);
    }

    private void putShort(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xff);
        b[off + 1] = (byte) ((v >> 8) & 0xff);
    }

    /* ------------------------- 相机 / 相册 ------------------------- */
    private void takePhoto() {
        if (Build.VERSION.SDK_INT < 29) { pickImage(); return; }
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Images.Media.DISPLAY_NAME, "yq_" + System.currentTimeMillis() + ".jpg");
            v.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            v.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Yuedu");
            v.put(MediaStore.Images.Media.IS_PENDING, 1);
            cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            startActivityForResult(i, REQ_CAMERA);
        } catch (Exception e) {
            pickImage();
        }
    }

    private void pickImage() {
        try {
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.setType("image/*");
            i.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(Intent.createChooser(i, "选择绘本图片"), REQ_GALLERY);
        } catch (Exception e) {
            js("window.Native.onError('无法打开相册')");
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_GALLERY_MULTI) {
            if (res == RESULT_OK && data != null) handleMultiImages(data);
            else js("window.Native.onPhotos('[]')");
            return;
        }
        if (req == REQ_FILE) {
            if (res == RESULT_OK && data != null && data.getData() != null) handleBookFile(data.getData());
            else js("window.Native.onBookFile('{}')");
            return;
        }
        Uri uri = null;
        if (req == REQ_CAMERA) {
            uri = cameraUri;
            if (res == RESULT_OK && cameraUri != null) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Images.Media.IS_PENDING, 0);
                try { getContentResolver().update(cameraUri, v, null, null); } catch (Exception ignored) {}
            }
        } else if (req == REQ_GALLERY && res == RESULT_OK && data != null) {
            uri = data.getData();
        }
        if (uri == null) {
            js("window.Native.onPhoto('')");
            return;
        }
        try {
            Bitmap bmp = decode(uri);
            if (bmp == null) {
                js("window.Native.onPhoto('')");
                return;
            }
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 82, bo);
            bmp.recycle();
            String b64 = Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
            js("window.Native.onPhoto('" + b64 + "')");
        } catch (Exception e) {
            js("window.Native.onPhoto('')");
        } catch (OutOfMemoryError e) {
            js("window.Native.onPhoto('')");
        }
    }

    private Bitmap decode(Uri uri) throws Exception {
        return decode(uri, 1600);
    }

    /* ------------------------- 多选图片（批量 OCR） ------------------------- */
    private void pickImages() {
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.setType("image/*");
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(Intent.createChooser(i, "选择绘本页面（可多选）"), REQ_GALLERY_MULTI);
        } catch (Exception e) {
            js("window.Native.onPhotos('[]')");
        }
    }

    private void handleMultiImages(Intent data) {
        List<String> list = new ArrayList<>();
        try {
            ClipData clip = data.getClipData();
            int n = clip == null ? (data.getData() != null ? 1 : 0) : clip.getItemCount();
            for (int k = 0; k < n && k < MAX_PICK_IMAGES; k++) {
                Uri u = clip == null ? data.getData() : clip.getItemAt(k).getUri();
                Bitmap bmp = decode(u, 1280);
                if (bmp == null) continue;
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                bmp.compress(Bitmap.CompressFormat.JPEG, 80, bo);
                bmp.recycle();
                list.add(Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP));
            }
        } catch (Exception ignored) {
        } catch (OutOfMemoryError ignored) {}
        sendPhotos(list);
    }

    /* ------------------------- 导入本地书籍 ------------------------- */
    private void pickBookFile() {
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "text/plain", "text/markdown", "text/html",
                "application/epub+zip", "application/pdf", "application/octet-stream"
            });
            startActivityForResult(Intent.createChooser(i, "选择书籍文件（txt / md / html / epub / pdf）"), REQ_FILE);
        } catch (Exception e) {
            js("window.Native.onBookFile(" + JSONObject.quote("{\"error\":\"无法打开文件选择器\"}") + ")");
        }
    }

    private void handleBookFile(Uri uri) {
        try {
            String name = displayName(uri);
            String lower = name.toLowerCase(Locale.ROOT);
            byte[] bytes = readAll(uri, MAX_BOOK_BYTES);
            if (bytes == null || bytes.length == 0) {
                sendBookError("文件读不出来，换一个试试");
                return;
            }
            if (lower.endsWith(".pdf")) {
                sendPdf(uri, name);
            } else if (lower.endsWith(".epub")) {
                sendBookText(name, "epub", epubToText(bytes));
            } else if (lower.endsWith(".docx") || lower.endsWith(".doc")) {
                sendBookError("暂不支持 Word，请另存为 txt 或 epub");
            } else {
                sendBookText(name, "text", decodeText(bytes));
            }
        } catch (Exception e) {
            sendBookError("解析失败：" + e.getMessage());
        } catch (OutOfMemoryError e) {
            sendBookError("文件太大，内存不够");
        }
    }

    private String displayName(Uri uri) {
        String name = "未命名";
        Cursor c = null;
        try {
            c = getContentResolver().query(uri, null, null, null, null);
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0 && !c.isNull(idx)) name = c.getString(idx);
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return name == null || name.trim().isEmpty() ? "未命名" : name;
    }

    private byte[] readAll(Uri uri, int limit) throws Exception {
        InputStream in = getContentResolver().openInputStream(uri);
        if (in == null) return null;
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n, total = 0;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > limit) { in.close(); return null; }
            bo.write(buf, 0, n);
        }
        in.close();
        return bo.toByteArray();
    }

    /** 先按 UTF-8 严格解码，失败再按 GB18030（很多中文 txt 是这个编码） */
    private String decodeText(byte[] bytes) {
        int off = 0;
        if (bytes.length >= 3 && (bytes[0] & 0xff) == 0xef && (bytes[1] & 0xff) == 0xbb && (bytes[2] & 0xff) == 0xbf) off = 3;
        try {
            CharsetDecoder dec = Charset.forName("UTF-8").newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
            return dec.decode(ByteBuffer.wrap(bytes, off, bytes.length - off)).toString();
        } catch (CharacterCodingException e) {
            try {
                return new String(bytes, off, bytes.length - off, Charset.forName("GB18030"));
            } catch (Exception e2) {
                return new String(bytes, off, bytes.length - off);
            }
        }
    }

    private String epubToText(byte[] bytes) throws Exception {
        ZipInputStream zin = new ZipInputStream(new ByteArrayInputStream(bytes));
        StringBuilder sb = new StringBuilder();
        ZipEntry e;
        while ((e = zin.getNextEntry()) != null && sb.length() < 600000) {
            String nm = e.getName().toLowerCase(Locale.ROOT);
            if (!(nm.endsWith(".xhtml") || nm.endsWith(".html") || nm.endsWith(".htm"))) continue;
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n, total = 0;
            while ((n = zin.read(buf)) > 0) {
                total += n;
                if (total > 400000) break;
                bo.write(buf, 0, n);
            }
            sb.append(stripHtml(decodeText(bo.toByteArray()))).append("\n\n");
        }
        zin.close();
        return sb.toString();
    }

    private String stripHtml(String html) {
        String s = html.replaceAll("(?is)<(script|style)[^>]*>.*?</\\1>", " ");
        s = s.replaceAll("(?i)<br\\s*/?>", "\n");
        s = s.replaceAll("(?i)</(p|div|h[1-6]|li|tr|section|article)>", "\n");
        s = s.replaceAll("(?s)<[^>]+>", " ");
        s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
             .replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'");
        s = s.replaceAll("&#(\\d+);", " ");
        return s;
    }

    private void sendBookText(String name, String kind, String text) {
        if (text == null) text = "";
        if (text.length() > 400000) text = text.substring(0, 400000);
        String json = "{\"kind\":\"" + kind + "\",\"name\":" + JSONObject.quote(name) +
            ",\"text\":" + JSONObject.quote(text) + "}";
        js("window.Native.onBookFile(" + json + ")");
    }

    private void sendBookError(String msg) {
        js("window.Native.onBookFile(" + JSONObject.quote("{\"error\":" + JSONObject.quote(msg) + "}") + ")");
    }

    /** PDF：先把每页渲染成图片，交给前端 OCR（PDF 里没有可直接抽取的文本层） */
    private void sendPdf(Uri uri, String name) throws Exception {
        ParcelFileDescriptor pfd = getContentResolver().openFileDescriptor(uri, "r");
        if (pfd == null) { sendBookError("打不开这个 PDF"); return; }
        PdfRenderer r = new PdfRenderer(pfd);
        int total = r.getPageCount();
        int pages = Math.min(total, 20);
        StringBuilder sb = new StringBuilder();
        sb.append("{\"kind\":\"pdf\",\"name\":").append(JSONObject.quote(name))
          .append(",\"total\":").append(total).append(",\"pages\":[");
        for (int i = 0; i < pages; i++) {
            PdfRenderer.Page p = r.openPage(i);
            int w = Math.max(600, Math.min(1240, p.getWidth() * 2));
            int h = Math.round((float) w * p.getHeight() / Math.max(1, p.getWidth()));
            Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            bmp.eraseColor(Color.WHITE);
            p.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
            p.close();
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 80, bo);
            bmp.recycle();
            if (i > 0) sb.append(',');
            sb.append('"').append(Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP)).append('"');
        }
        r.close();
        pfd.close();
        sb.append("]}");
        js("window.Native.onBookFile(" + sb + ")");
    }

    private void sendPhotos(List<String> list) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append('"').append(list.get(i)).append('"');
        }
        sb.append(']');
        js("window.Native.onPhotos('" + sb + "')");
    }

    private Bitmap decode(Uri uri, int max) throws Exception {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        InputStream in = getContentResolver().openInputStream(uri);
        BitmapFactory.decodeStream(in, null, o);
        in.close();
        int scale = 1;
        while (o.outWidth / (scale * 2) >= max || o.outHeight / (scale * 2) >= max) scale *= 2;
        BitmapFactory.Options o2 = new BitmapFactory.Options();
        o2.inSampleSize = scale;
        in = getContentResolver().openInputStream(uri);
        Bitmap bmp = BitmapFactory.decodeStream(in, null, o2);
        in.close();
        if (bmp == null) return null;
        int w = bmp.getWidth(), h = bmp.getHeight();
        float f = Math.min(1f, (float) max / Math.max(w, h));
        return Bitmap.createScaledBitmap(bmp, Math.round(w * f), Math.round(h * f), true);
    }

    /* ------------------------- 返回键 ------------------------- */
    private boolean handledBack = false;

    @Override
    public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        runOnUiThread(new Runnable() {
            @Override public void run() {
                web.evaluateJavascript(
                    "(function(){try{return !!(window.onAndroidBack&&window.onAndroidBack())}catch(e){return false}})()",
                    new android.webkit.ValueCallback<String>() {
                        @Override public void onReceiveValue(String value) {
                            if (!"true".equals(value)) finish();
                        }
                    });
            }
        });
    }

    @Override
    protected void onPause() {
        if (recording) cancelRec();
        if (tts != null) tts.stop();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        cancelRec();
        if (tts != null) { tts.stop(); tts.shutdown(); }
        if (web != null) {
            web.removeJavascriptInterface("Android");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /* ------------------------- JS Bridge ------------------------- */
    private class Bridge {
        @JavascriptInterface public boolean isNative() { return true; }

        @JavascriptInterface public String platform() { return "android-" + Build.VERSION.SDK_INT; }

        @JavascriptInterface public void speak(String text, float rate) { speakNow(text, rate, isZh(text)); }

        @JavascriptInterface public void stopSpeak() { if (tts != null) tts.stop(); }

        @JavascriptInterface public void vibrate(int ms) {
            try {
                Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                if (v != null) v.vibrate(Math.max(5, Math.min(60, ms)));
            } catch (Exception ignored) {}
        }

        @JavascriptInterface public boolean hasAudioPermission() {
            return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface public void requestAudioPermission() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
                }
            });
        }

        @JavascriptInterface public void recordStart() { startRec(); }

        @JavascriptInterface public String recordStop() { return stopRec(); }

        @JavascriptInterface public void recordCancel() { cancelRec(); }

        @JavascriptInterface public void takePhoto() { runOnUiThread(new Runnable() {
            @Override public void run() { MainActivity.this.takePhoto(); }
        }); }

        @JavascriptInterface public void pickImage() { runOnUiThread(new Runnable() {
            @Override public void run() { MainActivity.this.pickImage(); }
        }); }

        @JavascriptInterface public void pickImages() { runOnUiThread(new Runnable() {
            @Override public void run() { MainActivity.this.pickImages(); }
        }); }

        @JavascriptInterface public void pickBookFile() { runOnUiThread(new Runnable() {
            @Override public void run() { MainActivity.this.pickBookFile(); }
        }); }

        @JavascriptInterface public String httpGet(String url) {
            java.net.HttpURLConnection c = null;
            try {
                java.net.URL u = new java.net.URL(url);
                c = (java.net.HttpURLConnection) u.openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.setRequestProperty("User-Agent", "YueduApp/1.0");
                if (c.getResponseCode() != 200) return "";
                InputStream in = c.getInputStream();
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n, total = 0;
                while ((n = in.read(buf)) > 0 && total < 1200000) {
                    bo.write(buf, 0, n);
                    total += n;
                }
                in.close();
                return new String(bo.toByteArray(), "UTF-8");
            } catch (Exception e) {
                return "";
            } finally {
                if (c != null) c.disconnect();
            }
        }

        @JavascriptInterface public void toast(String msg) {
            android.widget.Toast.makeText(MainActivity.this, msg, android.widget.Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] grants) {
        if (req == REQ_AUDIO) {
            boolean ok = grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED;
            js("window.Native.onPermission(" + ok + ")");
        }
        super.onRequestPermissionsResult(req, perms, grants);
    }
}
