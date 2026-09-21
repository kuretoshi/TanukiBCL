namespace SuperNewRoles.Roles.Modifiers;

public record JumboData(float MaxSize);
public class JumboAbility
{
    private JumboData Data { get; } = new(4f);
    public float _currentSize { get; set; } = 1f;
}
