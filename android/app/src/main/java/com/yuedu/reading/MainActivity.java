package com.yuedu.reading;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.provider.MediaStore;
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

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

public class MainActivity extends Activity {

    private static final int REQ_AUDIO = 101;
    private static final int REQ_CAMERA = 102;
    private static final int REQ_GALLERY = 103;
    private static final int SAMPLE_RATE = 16000;

    private WebView web;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private String pendingTts = null;
    private float pendingRate = 1f;

    private AudioRecord recorder;
    private Thread recThread;
    private volatile boolean recording = false;
    private ByteArrayOutputStream pcmOut;
    private Uri cameraUri;

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
                        speakNow(pendingTts, pendingRate);
                        pendingTts = null;
                    }
                }
            }
        });
    }

    private void speakNow(String text, float rate) {
        if (!ttsReady || tts == null) {
            pendingTts = text;
            pendingRate = rate;
            return;
        }
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
            pcmOut = new ByteArrayOutputStream();
            recorder.startRecording();
            recording = true;
            recThread = new Thread(new Runnable() {
                @Override public void run() {
                    byte[] buf = new byte[2048];
                    long start = System.currentTimeMillis();
                    while (recording) {
                        int n = recorder.read(buf, 0, buf.length);
                        if (n > 0) pcmOut.write(buf, 0, n);
                        if (System.currentTimeMillis() - start > 60000) break;
                    }
                }
            });
            recThread.start();
        } catch (Exception e) {
            js("window.Native.onError('录音启动失败')");
        }
    }

    private String stopRec() {
        try {
            recording = false;
            if (recThread != null) recThread.join(600);
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
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        InputStream in = getContentResolver().openInputStream(uri);
        BitmapFactory.decodeStream(in, null, o);
        in.close();
        int max = 1600;
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

        @JavascriptInterface public void speak(String text, float rate) { speakNow(text, rate); }

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
