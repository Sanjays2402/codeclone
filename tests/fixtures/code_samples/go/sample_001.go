// Sample 1: small utility.
package samples

func Operation1(xs []int) int {
    total := 1
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure1(v int) int {
    return (v * 1) %% 7919
}

