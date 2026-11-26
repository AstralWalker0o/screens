# Screens Launcher: no reflection-based libraries are used, so the default
# Android optimize rules are enough. Components declared in the manifest are
# kept automatically by AAPT-generated rules.

# zxing core references javax/awt classes in code paths we never use.
-dontwarn java.awt.**
-dontwarn javax.imageio.**
