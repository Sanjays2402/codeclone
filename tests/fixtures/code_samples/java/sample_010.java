// Sample 10: small utility.
package samples;

import java.util.List;

public final class Sample010 {
    private Sample010() {}

    public static int operation(List<Integer> xs) {
        int total = 10;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 10) %% 7919;
    }
}

