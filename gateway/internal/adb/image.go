package adb

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
)

// Downscale returns src scaled to at most maxWidth pixels wide (keeping the
// aspect ratio) using area averaging. Images already narrow enough are
// returned as RGBA unchanged in size.
func Downscale(src image.Image, maxWidth int) *image.RGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	dw, dh := sw, sh
	if maxWidth > 0 && sw > maxWidth {
		dw = maxWidth
		dh = int(float64(sh)*float64(maxWidth)/float64(sw) + 0.5)
		if dh < 1 {
			dh = 1
		}
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	if sw == 0 || sh == 0 {
		return dst
	}
	px := pixelReader(src)
	// Precompute horizontal source spans.
	x0s := make([]int, dw)
	x1s := make([]int, dw)
	for x := 0; x < dw; x++ {
		x0 := x * sw / dw
		x1 := (x + 1) * sw / dw
		if x1 <= x0 {
			x1 = x0 + 1
		}
		x0s[x], x1s[x] = x0, x1
	}
	for y := 0; y < dh; y++ {
		y0 := y * sh / dh
		y1 := (y + 1) * sh / dh
		if y1 <= y0 {
			y1 = y0 + 1
		}
		row := dst.Pix[y*dst.Stride : y*dst.Stride+dw*4]
		for x := 0; x < dw; x++ {
			var r, g, bl, n uint32
			for sy := y0; sy < y1; sy++ {
				for sx := x0s[x]; sx < x1s[x]; sx++ {
					pr, pg, pb := px(b.Min.X+sx, b.Min.Y+sy)
					r += pr
					g += pg
					bl += pb
					n++
				}
			}
			i := x * 4
			row[i] = uint8(r / n)
			row[i+1] = uint8(g / n)
			row[i+2] = uint8(bl / n)
			row[i+3] = 0xff
		}
	}
	return dst
}

// pixelReader returns a fast 8-bit RGB accessor for common image types.
func pixelReader(src image.Image) func(x, y int) (uint32, uint32, uint32) {
	switch im := src.(type) {
	case *image.RGBA:
		return func(x, y int) (uint32, uint32, uint32) {
			i := im.PixOffset(x, y)
			return uint32(im.Pix[i]), uint32(im.Pix[i+1]), uint32(im.Pix[i+2])
		}
	case *image.NRGBA:
		// Screenshots are opaque; ignore alpha.
		return func(x, y int) (uint32, uint32, uint32) {
			i := im.PixOffset(x, y)
			return uint32(im.Pix[i]), uint32(im.Pix[i+1]), uint32(im.Pix[i+2])
		}
	default:
		return func(x, y int) (uint32, uint32, uint32) {
			r, g, b, _ := src.At(x, y).RGBA()
			return r >> 8, g >> 8, b >> 8
		}
	}
}

// PNGToJPEG decodes a PNG, downscales it and encodes it as JPEG.
func PNGToJPEG(pngData []byte, maxWidth, quality int) ([]byte, int, int, error) {
	img, err := png.Decode(bytes.NewReader(pngData))
	if err != nil {
		return nil, 0, 0, err
	}
	scaled := Downscale(img, maxWidth)
	if quality < 1 || quality > 100 {
		quality = 70
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, scaled, &jpeg.Options{Quality: quality}); err != nil {
		return nil, 0, 0, err
	}
	return out.Bytes(), scaled.Rect.Dx(), scaled.Rect.Dy(), nil
}
