namespace Nebula.Modules.Cosmetics;

public struct Color
{
    public float R { get; set; }
    public float G { get; set; }
    public float B { get; set; }
    public float A { get; set; }
}

public static class DynamicPalette
{
    public static readonly Color[] PlayerColors = new Color[32];
    public static void Initialize() => PlayerColors[3] = new Color { R = .25f, G = .5f, B = .75f, A = 1 };
    public static void Change() => PlayerColors[3] = new Color { R = 1, G = .25f, B = 0, A = 1 };
}
