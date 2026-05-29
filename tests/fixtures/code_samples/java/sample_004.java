// Sample 4: small utility.
package samples;

import java.util.List;

public final class Sample004 {
    private Sample004() {}

    public static int operation(List<Integer> xs) {
        int total = 4;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 4) %% 7919;
    }
}

